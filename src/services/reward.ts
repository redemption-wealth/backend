import { prisma } from "../db.js";
import { spendWithTx, creditWithTx } from "./wp.js";
import { evaluateMilestoneQuests } from "./quest.js";
import { EVM_ADDRESS_REGEX, type RedeemRewardInput } from "../schemas/wp.js";
import { isWibDayExpired } from "../lib/time.js";

// Reward categories that require a physical shipping address at redeem time.
const PHYSICAL_CATEGORIES = new Set(["MERCH", "SEMBAKO"]);

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

/** Reward's campaign window has closed (expiresAt in the past). Maps to 409. */
export class RewardExpiredError extends Error {
  constructor() {
    super("Reward sudah kedaluwarsa");
    this.name = "RewardExpiredError";
  }
}

/**
 * Physical reward (MERCH/SEMBAKO) redeemed without a complete shipping payload
 * (recipientName + recipientPhone + shippingAddress). Maps to 400.
 */
export class ShippingRequiredError extends Error {
  constructor() {
    super("Alamat pengiriman wajib diisi (nama, telepon, alamat)");
    this.name = "ShippingRequiredError";
  }
}

/**
 * CRYPTO reward redeemed without a valid EVM payout wallet (empty / non-0x /
 * wrong length). Maps to 400.
 */
export class WalletAddressRequiredError extends Error {
  constructor() {
    super("Alamat wallet tujuan tidak valid");
    this.name = "WalletAddressRequiredError";
  }
}

/**
 * Validate + narrow the category-specific fulfilment capture for a redeem.
 * Physical rewards (MERCH/SEMBAKO) need a complete shipping address; CRYPTO
 * rewards need a valid EVM wallet. Fields not relevant to the category are
 * dropped (never persisted). Throws a 400-mapped domain error on a missing/
 * invalid required field. Captured fields are write-once at redeem (no update path).
 */
function resolveFulfilment(
  category: string,
  input: RedeemRewardInput | undefined
): {
  recipientName: string | null;
  recipientPhone: string | null;
  shippingAddress: string | null;
  walletAddress: string | null;
} {
  const empty = {
    recipientName: null,
    recipientPhone: null,
    shippingAddress: null,
    walletAddress: null,
  };

  if (PHYSICAL_CATEGORIES.has(category)) {
    const name = input?.recipientName?.trim();
    const phone = input?.recipientPhone?.trim();
    const address = input?.shippingAddress?.trim();
    if (!name || !phone || !address) throw new ShippingRequiredError();
    return { ...empty, recipientName: name, recipientPhone: phone, shippingAddress: address };
  }

  if (category === "CRYPTO") {
    const wallet = input?.walletAddress?.trim();
    if (!wallet || !EVM_ADDRESS_REGEX.test(wallet)) throw new WalletAddressRequiredError();
    return { ...empty, walletAddress: wallet };
  }

  // VOUCHER (and any other category): no fulfilment capture.
  return empty;
}

/**
 * Active reward catalog, cheapest first. For AUTO rewards, availability is the
 * count of AVAILABLE pool assets — surfaced through `stock` so the app's existing
 * sold-out logic (`stock <= 0` → "habis") works unchanged, no client changes.
 */
export async function listRewards() {
  const rewards = await prisma.wpReward.findMany({
    where: { isActive: true },
    orderBy: [{ wpCost: "asc" }, { createdAt: "asc" }],
  });
  const autoIds = rewards
    .filter((r) => r.fulfillmentType === "AUTO")
    .map((r) => r.id);
  if (autoIds.length === 0) return rewards;

  const counts = await prisma.wpRewardAsset.groupBy({
    by: ["rewardId"],
    where: { rewardId: { in: autoIds }, status: "AVAILABLE" },
    _count: { _all: true },
  });
  const availByReward = new Map(counts.map((c) => [c.rewardId, c._count._all]));
  return rewards.map((r) =>
    r.fulfillmentType === "AUTO"
      ? { ...r, stock: availByReward.get(r.id) ?? 0 }
      : r
  );
}

/**
 * Redeem a reward with WP. Serialized per-reward (stock/pool safety); the inner
 * spend serializes per-user. Throws NotQualifiedError when the user hasn't
 * deposited, and InsufficientWpError (from spendWithTx) on a short balance.
 *
 * Two fulfillment paths:
 *   AUTO   → pull one AVAILABLE asset from the pool, mark the redemption
 *            FULFILLED instantly, and expose the asset value as the user-visible
 *            fulfillmentNote (empty pool → OutOfStockError, no WP is spent).
 *   MANUAL → decrement `stock` and create a PENDING redemption for an admin.
 */
export async function redeemReward(
  appUserId: string,
  rewardId: string,
  fulfilment?: RedeemRewardInput
) {
  const redemption = await prisma.$transaction(async (tx) => {
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
    // Expiry gate (all models): a date-boxed reward is valid through the END of
    // its WIB day (M3), so compare against end-of-day WIB — not the raw stored
    // midnight, which would close the reward ~17h early.
    if (reward.expiresAt && isWibDayExpired(reward.expiresAt))
      throw new RewardExpiredError();

    // Validate + narrow the category-specific fulfilment capture (shipping for
    // MERCH/SEMBAKO, EVM wallet for CRYPTO) BEFORE reserving stock or debiting WP.
    const capture = resolveFulfilment(reward.category, fulfilment);

    // AUTO instant-fulfilment is ONLY valid for digital vouchers. Physical goods
    // and CRYPTO must go through the MANUAL admin queue even if misconfigured as
    // AUTO — otherwise a crypto/goods redemption would be marked FULFILLED with a
    // pool string and no token/parcel ever sent.
    const isAuto = reward.fulfillmentType === "AUTO" && reward.category === "VOUCHER";

    // Reserve an asset (AUTO) or check stock (MANUAL) BEFORE spending WP.
    let asset: { id: string; value: string } | null = null;
    if (isAuto) {
      asset = await tx.wpRewardAsset.findFirst({
        where: { rewardId: reward.id, status: "AVAILABLE" },
        orderBy: { createdAt: "asc" },
        select: { id: true, value: true },
      });
      if (!asset) throw new OutOfStockError(); // empty pool
    } else if (reward.stock !== null && reward.stock <= 0) {
      throw new OutOfStockError();
    }

    // Debit WP (throws InsufficientWpError if the balance is short).
    await spendWithTx(tx, {
      appUserId,
      amount: reward.wpCost,
      type: "REDEEM_SPEND",
      refType: "reward",
      refId: reward.id,
      note: reward.title,
    });

    if (isAuto && asset) {
      const created = await tx.wpRedemption.create({
        data: {
          appUserId,
          rewardId: reward.id,
          wpSpent: reward.wpCost,
          status: "FULFILLED",
          fulfilledBy: "auto",
          fulfillmentNote: asset.value,
          ...capture,
        },
      });
      // Claim the asset. The per-reward advisory lock already serializes redeems,
      // but the status guard makes the assignment race-proof regardless.
      const claimed = await tx.wpRewardAsset.updateMany({
        where: { id: asset.id, status: "AVAILABLE" },
        data: { status: "ASSIGNED", redemptionId: created.id, assignedAt: new Date() },
      });
      if (claimed.count === 0) throw new OutOfStockError(); // lost the race → roll back
      return created;
    }

    // MANUAL: decrement stock, create a PENDING request for an admin to fulfill.
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
        ...capture,
      },
    });
  });

  // A FULFILLED redemption (AUTO) may complete this user's REDEEM milestone quest.
  if (redemption.status === "FULFILLED") {
    await evaluateMilestoneQuests(appUserId);
  }
  return redemption;
}

// ─── Admin: reward asset pool (AUTO fulfillment) ─────────────────────────────

/** Add pool assets to a reward in bulk. Blank/duplicate values are dropped. */
export async function addRewardAssets(
  rewardId: string,
  kind: string,
  values: string[]
) {
  const reward = await prisma.wpReward.findUnique({
    where: { id: rewardId },
    select: { id: true },
  });
  if (!reward) throw new RewardNotAvailableError(rewardId);

  const cleaned = Array.from(
    new Set(values.map((v) => v.trim()).filter((v) => v.length > 0))
  );
  if (cleaned.length === 0) return { added: 0 };

  const result = await prisma.wpRewardAsset.createMany({
    data: cleaned.map((value) => ({ rewardId, kind, value })),
  });
  return { added: result.count };
}

/** Admin: a reward's pool assets (newest first) plus available/assigned counts. */
export async function listRewardAssets(rewardId: string) {
  const [assets, available, assigned] = await Promise.all([
    prisma.wpRewardAsset.findMany({
      where: { rewardId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        kind: true,
        value: true,
        status: true,
        assignedAt: true,
        createdAt: true,
      },
    }),
    prisma.wpRewardAsset.count({ where: { rewardId, status: "AVAILABLE" } }),
    prisma.wpRewardAsset.count({ where: { rewardId, status: "ASSIGNED" } }),
  ]);
  return { assets, counts: { available, assigned } };
}

/** Admin: delete a still-AVAILABLE pool asset. Assigned assets can't be removed. */
export async function deleteRewardAsset(rewardId: string, assetId: string) {
  const deleted = await prisma.wpRewardAsset.deleteMany({
    where: { id: assetId, rewardId, status: "AVAILABLE" },
  });
  if (deleted.count === 0) {
    throw new RewardNotAvailableError(assetId); // gone, wrong reward, or already assigned
  }
  return { deleted: deleted.count };
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
  fulfillmentNote?: string,
  payoutTxHash?: string
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
        // CRYPTO campaign: record the manual on-chain payout tx hash if given.
        payoutTxHash: payoutTxHash ?? r.payoutTxHash,
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
      walletAddress: true,
      payoutTxHash: true,
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
    // CRYPTO: expose the payout wallet + tx hash so the user can verify receipt.
    walletAddress: r.walletAddress,
    payoutTxHash: r.payoutTxHash,
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
