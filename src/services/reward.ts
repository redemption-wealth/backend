import { prisma } from "../db.js";
import { spendWithTx, creditWithTx } from "./wp.js";
import { evaluateMilestoneQuests } from "./quest.js";

// WP reward catalog + redemption. Redeeming is gated on the anti-bot rule:
// only users who have actually deposited $WEALTH (hasDeposited) may spend WP on
// real rewards. Spend + stock decrement + request row are one atomic write.

export class NotQualifiedError extends Error {
  constructor() {
    super("Deposit $WEALTH dulu untuk bisa menukar poin");
    this.name = "NotQualifiedError";
  }
}

/**
 * Thrown when a user whose manual `fraudReviewStatus` is FLAGGED attempts a
 * "value-out" action (redeeming a reward or converting WP → $WEALTH). It is a
 * reversible label: setting the user back to NONE/CLEARED lifts the block
 * immediately. Earning (check-in / claim / referral) is never affected. Mapped
 * to HTTP 403 by the routes.
 */
export class AccountUnderReviewError extends Error {
  constructor() {
    super("Akun kamu sedang ditinjau. Penukaran & konversi dinonaktifkan sementara.");
    this.name = "AccountUnderReviewError";
  }
}

export class RewardNotAvailableError extends Error {
  constructor(public rewardId: string) {
    super(`Reward tidak tersedia: ${rewardId}`);
    this.name = "RewardNotAvailableError";
  }
}

export class OutOfStockError extends Error {
  constructor() {
    super("Stok reward habis");
    this.name = "OutOfStockError";
  }
}

/** Active reward catalog, cheapest first. */
export async function listRewards() {
  return prisma.wpReward.findMany({
    where: { isActive: true },
    orderBy: [{ wpCost: "asc" }, { createdAt: "asc" }],
  });
}

/**
 * Redeem a reward with WP. Serialized per-reward (stock safety); the inner
 * spend serializes per-user. Throws NotQualifiedError when the user hasn't
 * deposited, and InsufficientWpError (from spendWithTx) on a short balance.
 */
export async function redeemReward(appUserId: string, rewardId: string) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`reward:${rewardId}`}))`;

    const user = await tx.appUser.findUnique({
      where: { id: appUserId },
      select: { hasDeposited: true, fraudReviewStatus: true },
    });
    if (!user) throw new RewardNotAvailableError(rewardId);
    // Manual fraud-review gate: a FLAGGED user is blocked from this value-out
    // action (reversible — reading the current label restores access instantly).
    if (user.fraudReviewStatus === "FLAGGED") throw new AccountUnderReviewError();
    if (!user.hasDeposited) throw new NotQualifiedError(); // anti-bot gate

    const reward = await tx.wpReward.findUnique({ where: { id: rewardId } });
    if (!reward || !reward.isActive) throw new RewardNotAvailableError(rewardId);
    if (reward.stock !== null && reward.stock <= 0) throw new OutOfStockError();

    // Debit WP (throws InsufficientWpError if the balance is short).
    await spendWithTx(tx, {
      appUserId,
      amount: reward.wpCost,
      type: "REDEEM_SPEND",
      refType: "reward",
      refId: reward.id,
      note: reward.title,
    });

    if (reward.stock !== null) {
      await tx.wpReward.update({
        where: { id: reward.id },
        data: { stock: { decrement: 1 } },
      });
    }

    return tx.wpRedemption.create({
      data: {
        appUserId,
        rewardId: reward.id,
        wpSpent: reward.wpCost,
        status: "PENDING",
      },
    });
  });
}

export class RedemptionNotPendingError extends Error {
  constructor() {
    super("Penukaran sudah diproses");
    this.name = "RedemptionNotPendingError";
  }
}

export interface RedemptionListQuery {
  status?: string;
  limit?: number;
  offset?: number;
}

/** Admin: list WP redemption requests (newest first), optional status filter. */
export async function listWpRedemptions(q: RedemptionListQuery = {}) {
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 100);
  const offset = Math.max(q.offset ?? 0, 0);
  const where = q.status ? { status: q.status } : {};
  const [items, total] = await Promise.all([
    prisma.wpRedemption.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
      include: {
        reward: { select: { title: true, category: true } },
        appUser: { select: { email: true } },
      },
    }),
    prisma.wpRedemption.count({ where }),
  ]);
  return { items, total };
}

/**
 * Admin: mark a PENDING redemption FULFILLED. Idempotency-guarded. The optional
 * `fulfillmentNote` is user-visible (e.g. an issued voucher code / shipping note)
 * and is surfaced to the end user via GET /api/wp/redemptions.
 */
export async function fulfillRedemption(
  id: string,
  adminEmail: string,
  fulfillmentNote?: string
) {
  const redemption = await prisma.$transaction(async (tx) => {
    const r = await tx.wpRedemption.findUnique({ where: { id } });
    if (!r) throw new RewardNotAvailableError(id);
    if (r.status !== "PENDING") throw new RedemptionNotPendingError();
    return tx.wpRedemption.update({
      where: { id },
      data: {
        status: "FULFILLED",
        fulfilledBy: adminEmail,
        fulfillmentNote: fulfillmentNote ?? r.fulfillmentNote,
      },
    });
  });

  // A fulfilled redemption may complete this user's REDEEM milestone quest.
  await evaluateMilestoneQuests(redemption.appUserId);
  return redemption;
}

/**
 * Admin: reject a PENDING redemption — refund the WP spent and restore stock.
 * Atomic and idempotent (only acts while still PENDING).
 */
export async function rejectRedemption(
  id: string,
  adminEmail: string,
  note?: string
) {
  return prisma.$transaction(async (tx) => {
    const r = await tx.wpRedemption.findUnique({ where: { id } });
    if (!r) throw new RewardNotAvailableError(id);
    if (r.status !== "PENDING") throw new RedemptionNotPendingError();

    // Refund the spent WP.
    await creditWithTx(tx, {
      appUserId: r.appUserId,
      amount: r.wpSpent,
      type: "REDEEM_REFUND",
      refType: "reward",
      refId: r.rewardId,
      note: `Refund: ${note ?? "ditolak admin"}`,
    });

    // Restore stock if the reward is stock-limited.
    const reward = await tx.wpReward.findUnique({
      where: { id: r.rewardId },
      select: { stock: true },
    });
    if (reward && reward.stock !== null) {
      await tx.wpReward.update({
        where: { id: r.rewardId },
        data: { stock: { increment: 1 } },
      });
    }

    return tx.wpRedemption.update({
      where: { id },
      data: { status: "REJECTED", fulfilledBy: adminEmail, note: note ?? r.note },
    });
  });
}

export interface LedgerQuery {
  limit?: number;
  offset?: number;
}

/**
 * A user's own WP reward redemptions, newest first. Includes the user-visible
 * `fulfillmentNote` (voucher code / shipping note) set by the Manager on fulfill.
 * NOTE: WpReward has no dedicated `emoji` column, so the reward's `category` and
 * `imageUrl` are returned and the app maps them to an icon/emoji.
 */
export async function listUserRedemptions(appUserId: string, q: LedgerQuery = {}) {
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 100);
  const offset = Math.max(q.offset ?? 0, 0);
  const rows = await prisma.wpRedemption.findMany({
    where: { appUserId },
    orderBy: { createdAt: "desc" },
    take: limit,
    skip: offset,
    select: {
      id: true,
      wpSpent: true,
      status: true,
      fulfillmentNote: true,
      createdAt: true,
      reward: {
        select: { title: true, category: true, partnerName: true, imageUrl: true },
      },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    reward: {
      title: r.reward.title,
      category: r.reward.category,
      partnerName: r.reward.partnerName,
      imageUrl: r.reward.imageUrl,
    },
    wpSpent: r.wpSpent,
    status: r.status,
    fulfillmentNote: r.fulfillmentNote,
    createdAt: r.createdAt,
  }));
}

/** A user's WP ledger, newest first. */
export async function getLedger(appUserId: string, q: LedgerQuery = {}) {
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 100);
  const offset = Math.max(q.offset ?? 0, 0);
  return prisma.wpLedger.findMany({
    where: { appUserId },
    orderBy: { createdAt: "desc" },
    take: limit,
    skip: offset,
    select: {
      id: true,
      amount: true,
      type: true,
      refType: true,
      note: true,
      createdAt: true,
    },
  });
}
