import { prisma } from "../db.js";
import { wibMonthStartUtc } from "../lib/time.js";

// Admin-side WP read models: user listing with balances, per-user detail with
// ledger, and simple fraud signals (top earners / fast earners).

const ISSUANCE_TYPES = ["CHECKIN", "TASK", "REFERRAL_BONUS"];
const DEFAULT_MONTHLY_CAP = 1_000_000;

export interface WpOverview {
  totalWpOutstanding: number;
  issuedThisMonth: number;
  monthlyCapWp: number;
  capUsedPct: number;
  pendingRedemptions: number;
  pendingConversions: number;
  activeUsers: number;
  topEarnerWp: number | null;
}

/**
 * KPI snapshot for the back-office WP Overview tab. `activeUsers` is defined as
 * AppUsers with at least one WP ledger entry (i.e. anyone who has ever earned or
 * spent WP) — a broad "has engaged with the WP economy" signal.
 */
export async function getOverview(): Promise<WpOverview> {
  const [
    outstandingAgg,
    issuedAgg,
    settings,
    pendingRedemptions,
    pendingConversions,
    activeUsers,
    top,
  ] = await Promise.all([
    prisma.wpLedger.aggregate({ _sum: { amount: true } }),
    prisma.wpLedger.aggregate({
      _sum: { amount: true },
      where: {
        type: { in: ISSUANCE_TYPES },
        createdAt: { gte: wibMonthStartUtc() },
      },
    }),
    prisma.appSettings.findUnique({
      where: { id: "singleton" },
      select: { wpMonthlyCapWp: true },
    }),
    prisma.wpRedemption.count({ where: { status: "PENDING" } }),
    prisma.wpConversion.count({ where: { status: "PENDING" } }),
    prisma.appUser.count({ where: { ledger: { some: {} } } }),
    topEarners(1),
  ]);

  const monthlyCapWp = settings?.wpMonthlyCapWp ?? DEFAULT_MONTHLY_CAP;
  const issuedThisMonth = issuedAgg._sum.amount ?? 0;

  return {
    totalWpOutstanding: outstandingAgg._sum.amount ?? 0,
    issuedThisMonth,
    monthlyCapWp,
    capUsedPct: monthlyCapWp > 0 ? (issuedThisMonth / monthlyCapWp) * 100 : 0,
    pendingRedemptions,
    pendingConversions,
    activeUsers,
    topEarnerWp: top[0]?.totalWp ?? null,
  };
}

export interface AppUserListQuery {
  search?: string;
  limit?: number;
  offset?: number;
}

export async function listAppUsers(q: AppUserListQuery = {}) {
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 100);
  const offset = Math.max(q.offset ?? 0, 0);
  const where = q.search
    ? { email: { contains: q.search, mode: "insensitive" as const } }
    : {};

  const [users, total] = await Promise.all([
    prisma.appUser.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
      select: {
        id: true,
        email: true,
        walletAddress: true,
        referralCode: true,
        hasDeposited: true,
        createdAt: true,
        _count: { select: { referrals: true } },
      },
    }),
    prisma.appUser.count({ where }),
  ]);

  const balances = await prisma.wpLedger.groupBy({
    by: ["appUserId"],
    _sum: { amount: true },
    where: { appUserId: { in: users.map((u) => u.id) } },
  });
  const balMap = new Map(balances.map((b) => [b.appUserId, b._sum.amount ?? 0]));

  return {
    items: users.map((u) => ({
      id: u.id,
      email: u.email,
      walletAddress: u.walletAddress,
      referralCode: u.referralCode,
      hasDeposited: u.hasDeposited,
      createdAt: u.createdAt,
      referrals: u._count.referrals,
      balance: balMap.get(u.id) ?? 0,
    })),
    total,
  };
}

export async function getAppUserDetail(id: string) {
  const user = await prisma.appUser.findUnique({
    where: { id },
    select: {
      id: true,
      email: true,
      walletAddress: true,
      referralCode: true,
      referredById: true,
      hasDeposited: true,
      qualifiedAt: true,
      createdAt: true,
      _count: { select: { referrals: true } },
    },
  });
  if (!user) return null;

  const balAgg = await prisma.wpLedger.aggregate({
    _sum: { amount: true },
    where: { appUserId: id },
  });
  const ledger = await prisma.wpLedger.findMany({
    where: { appUserId: id },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return {
    ...user,
    referrals: user._count.referrals,
    balance: balAgg._sum?.amount ?? 0,
    ledger,
  };
}

async function joinEmails(
  rows: { appUserId: string; _sum: { amount: number | null } }[]
) {
  const users = await prisma.appUser.findMany({
    where: { id: { in: rows.map((r) => r.appUserId) } },
    select: { id: true, email: true, hasDeposited: true },
  });
  const byId = new Map(users.map((u) => [u.id, u]));
  return rows.map((r) => ({
    appUserId: r.appUserId,
    email: byId.get(r.appUserId)?.email ?? null,
    hasDeposited: byId.get(r.appUserId)?.hasDeposited ?? false,
    totalWp: r._sum.amount ?? 0,
  }));
}

/** Users with the highest lifetime WP balance. */
export async function topEarners(limit = 10) {
  const rows = await prisma.wpLedger.groupBy({
    by: ["appUserId"],
    _sum: { amount: true },
    orderBy: { _sum: { amount: "desc" } },
    take: limit,
  });
  return joinEmails(rows);
}

/** Users earning the most WP in the last 24h (issuance only) — farming signal. */
export async function fastEarners(limit = 10, sinceMs = 24 * 60 * 60 * 1000) {
  const since = new Date(Date.now() - sinceMs);
  const rows = await prisma.wpLedger.groupBy({
    by: ["appUserId"],
    _sum: { amount: true },
    where: { createdAt: { gte: since }, type: { in: ISSUANCE_TYPES } },
    orderBy: { _sum: { amount: "desc" } },
    take: limit,
  });
  return joinEmails(rows);
}
