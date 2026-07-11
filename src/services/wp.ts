import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { wibMonthStartUtc } from "../lib/time.js";

// WEALTH Points ledger service. Balance is always SUM(WpLedger.amount) — never
// a stored column — so it can't desync. All mutations go through a transaction.

export type WpLedgerType =
  | "CHECKIN"
  | "TASK"
  | "REFERRAL_BONUS"
  | "REDEEM_SPEND"
  | "REDEEM_REFUND"
  | "CONVERT_SPEND"
  | "CONVERT_REFUND"
  | "ADMIN_ADJUST";

// Types that count as "issuance" (new WP minted into circulation) and are
// therefore subject to the monthly cap. Refunds/spends/admin adjustments don't.
const ISSUANCE_TYPES: readonly WpLedgerType[] = [
  "CHECKIN",
  "TASK",
  "REFERRAL_BONUS",
];

const DEFAULT_MONTHLY_CAP = 1_000_000;

export class InsufficientWpError extends Error {
  constructor(public balance: number, public needed: number) {
    super(`Insufficient WP: have ${balance}, need ${needed}`);
    this.name = "InsufficientWpError";
  }
}

export class WpCapExceededError extends Error {
  constructor(public issued: number, public cap: number) {
    super(`Monthly WP issuance cap reached (${issued}/${cap})`);
    this.name = "WpCapExceededError";
  }
}

export interface WpEntryInput {
  appUserId: string;
  amount: number; // positive magnitude; sign is applied by credit/spend
  type: WpLedgerType;
  refType?: string | null;
  refId?: string | null;
  note?: string | null;
}

export interface WpEntryResult {
  ledgerId: string;
  balance: number;
}

/** Current WP balance for a user = SUM(ledger.amount). */
export async function getBalance(appUserId: string): Promise<number> {
  return sumBalance(prisma, appUserId);
}

/**
 * Credit (mint) WP within an existing transaction. Issuance types are checked
 * against the monthly cap and rejected with WpCapExceededError. Use this from
 * services that already own a transaction (e.g. quest claim) to avoid nesting.
 */
export async function creditWithTx(
  tx: Prisma.TransactionClient,
  input: WpEntryInput
): Promise<WpEntryResult> {
  if (input.amount <= 0) throw new Error("credit amount must be positive");
  if (ISSUANCE_TYPES.includes(input.type)) {
    await assertUnderMonthlyCap(tx, input.amount);
  }
  const entry = await tx.wpLedger.create({
    data: {
      appUserId: input.appUserId,
      amount: input.amount,
      type: input.type,
      refType: input.refType ?? null,
      refId: input.refId ?? null,
      note: input.note ?? null,
    },
    select: { id: true },
  });
  const balance = await sumBalance(tx, input.appUserId);
  return { ledgerId: entry.id, balance };
}

/** Credit WP in its own transaction. */
export async function credit(input: WpEntryInput): Promise<WpEntryResult> {
  return prisma.$transaction((tx) => creditWithTx(tx, input));
}

/**
 * Spend (debit) WP within an existing transaction. Serialized per-user with an
 * advisory lock so concurrent spends can't overspend. Throws InsufficientWpError.
 */
export async function spendWithTx(
  tx: Prisma.TransactionClient,
  input: WpEntryInput
): Promise<WpEntryResult> {
  if (input.amount <= 0) throw new Error("spend amount must be positive");
  // Serialize spends for this user (released at transaction end).
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.appUserId}))`;

  const balance = await sumBalance(tx, input.appUserId);
  if (balance < input.amount) {
    throw new InsufficientWpError(balance, input.amount);
  }
  const entry = await tx.wpLedger.create({
    data: {
      appUserId: input.appUserId,
      amount: -input.amount,
      type: input.type,
      refType: input.refType ?? null,
      refId: input.refId ?? null,
      note: input.note ?? null,
    },
    select: { id: true },
  });
  return { ledgerId: entry.id, balance: balance - input.amount };
}

/** Spend WP in its own transaction. */
export async function spend(input: WpEntryInput): Promise<WpEntryResult> {
  return prisma.$transaction((tx) => spendWithTx(tx, input));
}

/**
 * Admin grant/clawback. `delta` may be negative (clawback). Not subject to the
 * monthly cap and allowed to drive the balance negative — it's a manual override.
 */
export async function adminAdjust(
  appUserId: string,
  delta: number,
  note?: string
): Promise<WpEntryResult> {
  if (!Number.isInteger(delta) || delta === 0) {
    throw new Error("adjust delta must be a non-zero integer");
  }
  return prisma.$transaction(async (tx) => {
    const entry = await tx.wpLedger.create({
      data: {
        appUserId,
        amount: delta,
        type: "ADMIN_ADJUST",
        refType: "admin",
        note: note ?? null,
      },
      select: { id: true },
    });
    const balance = await sumBalance(tx, appUserId);
    return { ledgerId: entry.id, balance };
  });
}

// ─── internals ───────────────────────────────────────────────────────────────

type LedgerClient = Pick<Prisma.TransactionClient, "wpLedger" | "appSettings">;

async function sumBalance(
  client: LedgerClient,
  appUserId: string
): Promise<number> {
  const agg = await client.wpLedger.aggregate({
    _sum: { amount: true },
    where: { appUserId },
  });
  return agg._sum.amount ?? 0;
}

async function assertUnderMonthlyCap(
  client: LedgerClient,
  amount: number
): Promise<void> {
  const settings = await client.appSettings.findUnique({
    where: { id: "singleton" },
    select: { wpMonthlyCapWp: true },
  });
  const cap = settings?.wpMonthlyCapWp ?? DEFAULT_MONTHLY_CAP;

  const agg = await client.wpLedger.aggregate({
    _sum: { amount: true },
    where: {
      type: { in: [...ISSUANCE_TYPES] },
      createdAt: { gte: wibMonthStartUtc() },
    },
  });
  const issued = agg._sum?.amount ?? 0;

  if (issued + amount > cap) {
    throw new WpCapExceededError(issued, cap);
  }
}
