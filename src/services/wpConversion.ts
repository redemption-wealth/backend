import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { spendWithTx, creditWithTx } from "./wp.js";
import { NotQualifiedError, AccountUnderReviewError } from "./reward.js";
import { wibMonthStartUtc } from "../lib/time.js";

// WP → $WEALTH conversion. Treasury is MANUAL: the user burns WP (CONVERT_SPEND)
// to create a PENDING conversion; an admin then sends $WEALTH off-system and
// marks it FULFILLED (records an optional txHash) or REJECTED (refunds the WP
// via CONVERT_REFUND). The backend never signs / sends on-chain.
//
// Anti-sybil: a user's cumulative converted $WEALTH (PENDING+FULFILLED) is
// capped at their confirmed-deposit total — the $WEALTH they have actually put
// through the system via CONFIRMED redemptions — PLUS a per-user monthly WP
// ceiling, a global monthly $WEALTH budget, and the hasDeposited gate.

const CONVERTED_STATUSES = ["PENDING", "FULFILLED"] as const;

const DEFAULTS = {
  wpConversionEnabled: false,
  wpConversionRate: 1000,
  wpConvertMinWp: 1000,
  wpConvertMaxWpPerMonth: 100000,
  wpConversionMonthlyBudgetWealth: new Prisma.Decimal(10000),
};

export class ConversionDisabledError extends Error {
  constructor() {
    super("Konversi WP ke $WEALTH sedang tidak aktif");
    this.name = "ConversionDisabledError";
  }
}

export class ConversionBelowMinError extends Error {
  constructor(public min: number) {
    super(`Minimal konversi ${min} WP`);
    this.name = "ConversionBelowMinError";
  }
}

export class MonthlyWpLimitError extends Error {
  constructor(public remaining: number) {
    super(`Sisa kuota konversi bulan ini ${remaining} WP`);
    this.name = "MonthlyWpLimitError";
  }
}

export class DepositCapError extends Error {
  constructor(public depositTotal: string, public alreadyConverted: string) {
    super("Konversi melebihi total deposit $WEALTH kamu");
    this.name = "DepositCapError";
  }
}

export class MonthlyBudgetError extends Error {
  constructor() {
    super("Anggaran konversi $WEALTH bulan ini sudah habis, coba lagi nanti");
    this.name = "MonthlyBudgetError";
  }
}

export class ConversionNotFoundError extends Error {
  constructor(public id: string) {
    super(`Konversi tidak ditemukan: ${id}`);
    this.name = "ConversionNotFoundError";
  }
}

export class ConversionNotPendingError extends Error {
  constructor() {
    super("Konversi sudah diproses");
    this.name = "ConversionNotPendingError";
  }
}

type SettingsClient = Pick<Prisma.TransactionClient, "appSettings">;
type ConversionClient = Pick<Prisma.TransactionClient, "wpConversion">;
type RedemptionClient = Pick<Prisma.TransactionClient, "redemption">;

async function loadSettings(client: SettingsClient) {
  const s = await client.appSettings.findUnique({
    where: { id: "singleton" },
    select: {
      wpConversionEnabled: true,
      wpConversionRate: true,
      wpConvertMinWp: true,
      wpConvertMaxWpPerMonth: true,
      wpConversionMonthlyBudgetWealth: true,
    },
  });
  return {
    wpConversionEnabled: s?.wpConversionEnabled ?? DEFAULTS.wpConversionEnabled,
    wpConversionRate: s?.wpConversionRate ?? DEFAULTS.wpConversionRate,
    wpConvertMinWp: s?.wpConvertMinWp ?? DEFAULTS.wpConvertMinWp,
    wpConvertMaxWpPerMonth:
      s?.wpConvertMaxWpPerMonth ?? DEFAULTS.wpConvertMaxWpPerMonth,
    wpConversionMonthlyBudgetWealth:
      s?.wpConversionMonthlyBudgetWealth ??
      DEFAULTS.wpConversionMonthlyBudgetWealth,
  };
}

/** WP a user has already converted (PENDING+FULFILLED) this WIB month. */
async function convertedWpThisMonth(
  client: ConversionClient,
  appUserId: string
): Promise<number> {
  const agg = await client.wpConversion.aggregate({
    _sum: { wpBurned: true },
    where: {
      appUserId,
      status: { in: [...CONVERTED_STATUSES] },
      createdAt: { gte: wibMonthStartUtc() },
    },
  });
  return agg._sum.wpBurned ?? 0;
}

/** A user's cumulative converted $WEALTH (PENDING+FULFILLED), all-time. */
async function convertedWealthCumulative(
  client: ConversionClient,
  appUserId: string
): Promise<Prisma.Decimal> {
  const agg = await client.wpConversion.aggregate({
    _sum: { wealthAmount: true },
    where: { appUserId, status: { in: [...CONVERTED_STATUSES] } },
  });
  return agg._sum.wealthAmount ?? new Prisma.Decimal(0);
}

/** Global converted $WEALTH (PENDING+FULFILLED) this WIB month, all users. */
async function convertedWealthThisMonthGlobal(
  client: ConversionClient
): Promise<Prisma.Decimal> {
  const agg = await client.wpConversion.aggregate({
    _sum: { wealthAmount: true },
    where: {
      status: { in: [...CONVERTED_STATUSES] },
      createdAt: { gte: wibMonthStartUtc() },
    },
  });
  return agg._sum.wealthAmount ?? new Prisma.Decimal(0);
}

/**
 * Anti-sybil deposit cap source: the $WEALTH a user has actually sent through
 * the system via CONFIRMED redemptions. Keyed by `appUserId` — the SAME identity
 * the `hasDeposited` gate uses (services/appUser.ts:userHasConfirmedRedemption)
 * and the SAME identity conversions are charged against
 * (convertedWealthCumulative). It must NOT key by the shared, non-unique Privy
 * email: one email backs many AppUser accounts, so an email-keyed ceiling would
 * let each sybil convert against the COMBINED deposits of every account sharing
 * the email (extracting N²·d $WEALTH for N·d deposited).
 */
async function confirmedDepositTotal(
  client: RedemptionClient,
  appUserId: string
): Promise<Prisma.Decimal> {
  const agg = await client.redemption.aggregate({
    _sum: { wealthAmount: true },
    where: { appUserId, status: "CONFIRMED" },
  });
  return agg._sum.wealthAmount ?? new Prisma.Decimal(0);
}

export interface ConvertUser {
  id: string;
  email: string;
  fraudReviewStatus: "NONE" | "REVIEWING" | "CLEARED" | "FLAGGED";
}

/**
 * Convert WP to $WEALTH: burn the WP and open a PENDING conversion request.
 * Enforces (in order): the enabled switch, the hasDeposited gate, the minimum,
 * the per-user monthly WP ceiling, the anti-sybil deposit cap, and the global
 * monthly $WEALTH budget. All the state-changing work (re-checks + burn +
 * create) happens inside one transaction under a per-user advisory lock so
 * concurrent requests can't bypass the caps or overspend.
 */
export async function convertWp(
  appUser: ConvertUser,
  wpAmount: number,
  toAddress: string
) {
  if (!Number.isInteger(wpAmount) || wpAmount <= 0) {
    throw new ConversionBelowMinError(DEFAULTS.wpConvertMinWp);
  }

  const settings = await loadSettings(prisma);
  if (!settings.wpConversionEnabled) throw new ConversionDisabledError();
  // Manual fraud-review gate: a FLAGGED user is blocked from this value-out
  // action (reversible — set back to NONE/CLEARED to restore access instantly).
  if (appUser.fraudReviewStatus === "FLAGGED") throw new AccountUnderReviewError();
  if (wpAmount < settings.wpConvertMinWp) {
    throw new ConversionBelowMinError(settings.wpConvertMinWp);
  }
  if (settings.wpConversionRate <= 0) {
    throw new Error("wpConversionRate must be positive");
  }

  // $WEALTH owed, at the project's 4-dp WEALTH rounding.
  const wealthAmount = new Prisma.Decimal(wpAmount)
    .div(settings.wpConversionRate)
    .toDecimalPlaces(4);
  if (wealthAmount.lte(0)) throw new ConversionBelowMinError(settings.wpConvertMinWp);

  return prisma.$transaction(async (tx) => {
    // Serialize this user's conversions (reentrant with spendWithTx's lock).
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${appUser.id}))`;

    // Per-user monthly WP ceiling.
    const usedWp = await convertedWpThisMonth(tx, appUser.id);
    const remainingWp = settings.wpConvertMaxWpPerMonth - usedWp;
    if (wpAmount > remainingWp) {
      throw new MonthlyWpLimitError(Math.max(0, remainingWp));
    }

    // Anti-sybil deposit cap: cumulative converted ≤ confirmed-deposit total.
    const [depositTotal, alreadyConverted] = await Promise.all([
      confirmedDepositTotal(tx, appUser.id),
      convertedWealthCumulative(tx, appUser.id),
    ]);
    // Anti-bot gate — LIVE: a user with zero confirmed deposits (e.g. their only
    // redemption was refunded) has no headroom and isn't eligible to convert.
    if (depositTotal.lte(0)) throw new NotQualifiedError();
    if (alreadyConverted.add(wealthAmount).gt(depositTotal)) {
      throw new DepositCapError(depositTotal.toString(), alreadyConverted.toString());
    }

    // Global monthly $WEALTH budget. The per-user lock above does NOT order two
    // different users, so without a shared lock both could read the same
    // pre-commit global total and jointly overshoot the budget. Take a single
    // constant-keyed lock so the read+check+burn of the budget-affecting section
    // is serialized across ALL users. (Always acquired AFTER the per-user lock;
    // no other path takes this key, so the ordering can't deadlock.)
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('wp-convert-budget'))`;
    const globalThisMonth = await convertedWealthThisMonthGlobal(tx);
    if (
      globalThisMonth.add(wealthAmount).gt(settings.wpConversionMonthlyBudgetWealth)
    ) {
      throw new MonthlyBudgetError();
    }

    // Burn the WP (throws InsufficientWpError on a short balance).
    await spendWithTx(tx, {
      appUserId: appUser.id,
      amount: wpAmount,
      type: "CONVERT_SPEND",
      refType: "conversion",
      note: `Konversi ${wpAmount} WP → ${wealthAmount.toString()} $WEALTH`,
    });

    const conversion = await tx.wpConversion.create({
      data: {
        appUserId: appUser.id,
        wpBurned: wpAmount,
        wealthAmount,
        rate: settings.wpConversionRate,
        toAddress,
        status: "PENDING",
      },
    });

    // Backfill the ledger row's refId with the conversion id for traceability.
    await tx.wpLedger.updateMany({
      where: {
        appUserId: appUser.id,
        type: "CONVERT_SPEND",
        refType: "conversion",
        refId: null,
      },
      data: { refId: conversion.id },
    });

    return conversion;
  });
}

export interface ConvertInfo {
  enabled: boolean;
  rate: number;
  minWp: number;
  maxWpPerMonth: number;
  remainingWpThisMonth: number;
  hasDeposited: boolean;
}

/** Everything the app needs to render the convert screen without guessing. */
export async function getConvertInfo(appUser: ConvertUser): Promise<ConvertInfo> {
  const settings = await loadSettings(prisma);
  const usedWp = await convertedWpThisMonth(prisma, appUser.id);
  // LIVE eligibility: ≥1 CONFIRMED redemption for this account.
  const deposited =
    (await prisma.redemption.count({
      where: { appUserId: appUser.id, status: "CONFIRMED" },
    })) > 0;
  return {
    enabled: settings.wpConversionEnabled,
    rate: settings.wpConversionRate,
    minWp: settings.wpConvertMinWp,
    maxWpPerMonth: settings.wpConvertMaxWpPerMonth,
    remainingWpThisMonth: Math.max(0, settings.wpConvertMaxWpPerMonth - usedWp),
    hasDeposited: deposited,
  };
}

export interface ConversionListQuery {
  limit?: number;
  offset?: number;
}

/** A user's own conversion requests, newest first. */
export async function listUserConversions(
  appUserId: string,
  q: ConversionListQuery = {}
) {
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 100);
  const offset = Math.max(q.offset ?? 0, 0);
  return prisma.wpConversion.findMany({
    where: { appUserId },
    orderBy: { createdAt: "desc" },
    take: limit,
    skip: offset,
    select: {
      id: true,
      wpBurned: true,
      wealthAmount: true,
      rate: true,
      toAddress: true,
      status: true,
      txHash: true,
      createdAt: true,
    },
  });
}

export interface AdminConversionListQuery {
  status?: string;
  limit?: number;
  offset?: number;
}

/** Admin: list conversion requests (newest first), optional status filter. */
export async function listConversions(q: AdminConversionListQuery = {}) {
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 100);
  const offset = Math.max(q.offset ?? 0, 0);
  const where = q.status ? { status: q.status as never } : {};
  const [rows, total] = await Promise.all([
    prisma.wpConversion.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
      include: {
        appUser: { select: { id: true, email: true, walletAddress: true } },
      },
    }),
    prisma.wpConversion.count({ where }),
  ]);
  const conversions = rows.map((r) => ({
    id: r.id,
    user: {
      id: r.appUser.id,
      email: r.appUser.email,
      walletAddress: r.appUser.walletAddress,
    },
    wpBurned: r.wpBurned,
    wealthAmount: r.wealthAmount,
    rate: r.rate,
    toAddress: r.toAddress,
    status: r.status,
    txHash: r.txHash,
    note: r.note,
    createdAt: r.createdAt,
  }));
  return { conversions, total };
}

/**
 * Admin: mark a PENDING conversion FULFILLED. The admin has already sent the
 * $WEALTH manually off-system — this only records the outcome (optional txHash /
 * note). Idempotency-guarded: only acts while still PENDING. NO on-chain send.
 */
export async function fulfillConversion(
  id: string,
  opts: { txHash?: string; note?: string; fulfilledBy: string }
) {
  return prisma.$transaction(async (tx) => {
    const c = await tx.wpConversion.findUnique({ where: { id } });
    if (!c) throw new ConversionNotFoundError(id);
    if (c.status !== "PENDING") throw new ConversionNotPendingError();
    return tx.wpConversion.update({
      where: { id },
      data: {
        status: "FULFILLED",
        fulfilledBy: opts.fulfilledBy,
        txHash: opts.txHash ?? c.txHash,
        note: opts.note ?? c.note,
      },
    });
  });
}

/**
 * Admin: reject a PENDING conversion — refund the burned WP (CONVERT_REFUND),
 * which also frees the per-user deposit cap and the monthly budget. Atomic and
 * idempotent (only acts while still PENDING).
 */
export async function rejectConversion(
  id: string,
  opts: { note?: string; fulfilledBy: string }
) {
  return prisma.$transaction(async (tx) => {
    const c = await tx.wpConversion.findUnique({ where: { id } });
    if (!c) throw new ConversionNotFoundError(id);
    if (c.status !== "PENDING") throw new ConversionNotPendingError();

    await creditWithTx(tx, {
      appUserId: c.appUserId,
      amount: c.wpBurned,
      type: "CONVERT_REFUND",
      refType: "conversion",
      refId: c.id,
      note: `Refund konversi: ${opts.note ?? "ditolak admin"}`,
    });

    return tx.wpConversion.update({
      where: { id },
      data: {
        status: "REJECTED",
        fulfilledBy: opts.fulfilledBy,
        note: opts.note ?? c.note,
      },
    });
  });
}
