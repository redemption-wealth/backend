import { prisma } from "../db.js";
import { wibMonthStartUtc } from "../lib/time.js";
import { deriveTier } from "../lib/wp-tiers.js";

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

  const userIds = users.map((u) => u.id);

  // Three aggregate passes over the ledger, each scoped to just this page's
  // users (no N+1): current balance (SUM all), lifetime earned (SUM positives),
  // and last-active (MAX createdAt).
  const [balances, earned, lastActive] = await Promise.all([
    prisma.wpLedger.groupBy({
      by: ["appUserId"],
      _sum: { amount: true },
      where: { appUserId: { in: userIds } },
    }),
    prisma.wpLedger.groupBy({
      by: ["appUserId"],
      _sum: { amount: true },
      where: { appUserId: { in: userIds }, amount: { gt: 0 } },
    }),
    prisma.wpLedger.groupBy({
      by: ["appUserId"],
      _max: { createdAt: true },
      where: { appUserId: { in: userIds } },
    }),
  ]);
  const balMap = new Map(balances.map((b) => [b.appUserId, b._sum.amount ?? 0]));
  const earnedMap = new Map(earned.map((e) => [e.appUserId, e._sum.amount ?? 0]));
  const lastActiveMap = new Map(
    lastActive.map((l) => [l.appUserId, l._max.createdAt ?? null])
  );

  return {
    items: users.map((u) => {
      const totalEarnedWp = earnedMap.get(u.id) ?? 0;
      return {
        id: u.id,
        email: u.email,
        walletAddress: u.walletAddress,
        referralCode: u.referralCode,
        hasDeposited: u.hasDeposited,
        createdAt: u.createdAt,
        referrals: u._count.referrals,
        balance: balMap.get(u.id) ?? 0,
        totalEarnedWp,
        lastActiveAt: lastActiveMap.get(u.id) ?? null,
        tier: deriveTier(totalEarnedWp),
      };
    }),
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
      fraudReviewStatus: true,
      createdAt: true,
      _count: { select: { referrals: true } },
    },
  });
  if (!user) return null;

  const [balAgg, earnedAgg, lastActiveAgg, ledger] = await Promise.all([
    prisma.wpLedger.aggregate({ _sum: { amount: true }, where: { appUserId: id } }),
    prisma.wpLedger.aggregate({
      _sum: { amount: true },
      where: { appUserId: id, amount: { gt: 0 } },
    }),
    prisma.wpLedger.aggregate({ _max: { createdAt: true }, where: { appUserId: id } }),
    prisma.wpLedger.findMany({
      where: { appUserId: id },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
  ]);
  const totalEarnedWp = earnedAgg._sum?.amount ?? 0;

  return {
    ...user,
    referrals: user._count.referrals,
    balance: balAgg._sum?.amount ?? 0,
    totalEarnedWp,
    lastActiveAt: lastActiveAgg._max?.createdAt ?? null,
    tier: deriveTier(totalEarnedWp),
    ledger,
  };
}

export interface EarnerRow {
  appUserId: string;
  email: string | null;
  hasDeposited: boolean;
  totalWp: number;
  fraudReviewStatus: "NONE" | "REVIEWING" | "CLEARED" | "FLAGGED";
}

async function joinEmails(
  rows: { appUserId: string; _sum: { amount: number | null } }[]
): Promise<EarnerRow[]> {
  const users = await prisma.appUser.findMany({
    where: { id: { in: rows.map((r) => r.appUserId) } },
    select: { id: true, email: true, hasDeposited: true, fraudReviewStatus: true },
  });
  const byId = new Map(users.map((u) => [u.id, u]));
  return rows.map((r) => ({
    appUserId: r.appUserId,
    email: byId.get(r.appUserId)?.email ?? null,
    hasDeposited: byId.get(r.appUserId)?.hasDeposited ?? false,
    totalWp: r._sum.amount ?? 0,
    fraudReviewStatus: byId.get(r.appUserId)?.fraudReviewStatus ?? "NONE",
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

// ─── Fraud report (WP Fraud tab) ─────────────────────────────────────────────

// A user whose recent 24h issuance is at least this fraction of their lifetime
// balance looks like a burst-farmer — flag it as a high earn ratio.
const HIGH_EARN_RATIO = 0.6;
const FAST_EARN_WINDOW_MS = 24 * 60 * 60 * 1000;

export type FraudReason = "Top earner" | "Earn cepat 24 jam" | "Rasio earn tinggi";

export interface FraudEarnerRow extends EarnerRow {
  /** Human-readable heuristic explaining why this user surfaced. */
  reason: FraudReason;
  /** WP issued to this user in the last 24h (issuance types only). */
  wpIn24h: number;
  /** Timestamp of the user's most recent ledger entry, or null. */
  lastActiveAt: Date | null;
}

export interface FraudReport {
  topEarners: FraudEarnerRow[];
  fastEarners: FraudEarnerRow[];
  summary: {
    topEarnerWp: number;
    fastest24hWp: number;
    reviewingCount: number;
    flaggedCount: number;
    clearedCount: number;
  };
}

function classifyReason(
  context: "top" | "fast",
  totalWp: number,
  wpIn24h: number
): FraudReason {
  if (totalWp > 0 && wpIn24h / totalWp >= HIGH_EARN_RATIO) {
    return "Rasio earn tinggi";
  }
  return context === "top" ? "Top earner" : "Earn cepat 24 jam";
}

/**
 * Enriched fraud signals for the back-office WP Fraud tab. Returns the top
 * lifetime earners and the fastest 24h earners, each row annotated with a
 * heuristic `reason`, the user's manual `fraudReviewStatus`, WP earned in the
 * last 24h and last-active timestamp. `summary` feeds the Figma summary cards.
 *
 * IMPORTANT: this is a read/observability model only. Nothing here freezes or
 * blocks a user — review is a manual, label-only workflow (see PATCH review).
 */
export async function getFraudReport(limit = 10): Promise<FraudReport> {
  const [top, fast] = await Promise.all([topEarners(limit), fastEarners(limit)]);

  const ids = Array.from(
    new Set([...top, ...fast].map((r) => r.appUserId))
  );

  const since = new Date(Date.now() - FAST_EARN_WINDOW_MS);
  const [wp24hRows, lastActiveRows, reviewingCount, flaggedCount, clearedCount] =
    await Promise.all([
      ids.length
        ? prisma.wpLedger.groupBy({
            by: ["appUserId"],
            _sum: { amount: true },
            where: {
              appUserId: { in: ids },
              createdAt: { gte: since },
              type: { in: ISSUANCE_TYPES },
            },
          })
        : Promise.resolve([]),
      ids.length
        ? prisma.wpLedger.groupBy({
            by: ["appUserId"],
            _max: { createdAt: true },
            where: { appUserId: { in: ids } },
          })
        : Promise.resolve([]),
      prisma.appUser.count({ where: { fraudReviewStatus: "REVIEWING" } }),
      prisma.appUser.count({ where: { fraudReviewStatus: "FLAGGED" } }),
      prisma.appUser.count({ where: { fraudReviewStatus: "CLEARED" } }),
    ]);

  const wp24hMap = new Map(wp24hRows.map((r) => [r.appUserId, r._sum.amount ?? 0]));
  const lastActiveMap = new Map(
    lastActiveRows.map((r) => [r.appUserId, r._max.createdAt ?? null])
  );

  const enrich = (row: EarnerRow, context: "top" | "fast"): FraudEarnerRow => {
    const wpIn24h = wp24hMap.get(row.appUserId) ?? 0;
    return {
      ...row,
      wpIn24h,
      lastActiveAt: lastActiveMap.get(row.appUserId) ?? null,
      reason: classifyReason(context, row.totalWp, wpIn24h),
    };
  };

  return {
    topEarners: top.map((r) => enrich(r, "top")),
    fastEarners: fast.map((r) => enrich(r, "fast")),
    summary: {
      topEarnerWp: top[0]?.totalWp ?? 0,
      fastest24hWp: Math.max(0, ...fast.map((r) => wp24hMap.get(r.appUserId) ?? 0)),
      reviewingCount,
      flaggedCount,
      clearedCount,
    },
  };
}

/** Set an AppUser's manual fraud-review label. Returns null if not found. */
export async function setFraudReviewStatus(
  appUserId: string,
  status: "NONE" | "REVIEWING" | "CLEARED" | "FLAGGED"
): Promise<{ appUserId: string; fraudReviewStatus: typeof status } | null> {
  const exists = await prisma.appUser.findUnique({
    where: { id: appUserId },
    select: { id: true },
  });
  if (!exists) return null;

  const updated = await prisma.appUser.update({
    where: { id: appUserId },
    data: { fraudReviewStatus: status },
    select: { id: true, fraudReviewStatus: true },
  });
  return { appUserId: updated.id, fraudReviewStatus: updated.fraudReviewStatus };
}
