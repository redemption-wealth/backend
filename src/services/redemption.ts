import { randomUUID } from "crypto";
import { prisma } from "../db.js";
import { Prisma } from "@prisma/client";
import { createPublicClient, http } from "viem";
import { resolveChain } from "../lib/chain.js";
import { generateQrCode, deleteQrFiles } from "./qr-generator.js";
import { getWealthPrice } from "./price.js";

interface InitiateRedemptionParams {
  userEmail: string;
  voucherId: string;
  idempotencyKey: string;
}

export async function initiateRedemption({
  userEmail,
  voucherId,
  idempotencyKey,
}: InitiateRedemptionParams) {
  // Check idempotency (scoped to user)
  const existing = await prisma.redemption.findFirst({
    where: { idempotencyKey, userEmail },
  });
  if (existing) {
    return { redemption: existing, alreadyExists: true };
  }

  // Fetch app settings for fees
  const settings = await prisma.appSettings.findUnique({
    where: { id: "singleton" },
  });
  const appFeePercentage = settings?.appFeeRate ?? new Prisma.Decimal(3);
  const gasFeeIdr = settings?.gasFeeAmount ?? new Prisma.Decimal(0);

  // Fetch WEALTH price server-side — must be outside $transaction to avoid holding DB connection during network call
  let priceIdr: number;
  try {
    const result = await getWealthPrice();
    priceIdr = result.priceIdr;
  } catch {
    throw new Error("Price service unavailable");
  }

  // Pre-generate redemptionId so we can use it for QR R2 keys before the transaction
  const redemptionId = randomUUID();

  // --- Transaction with row-level locking ---
  let uploadedImageUrls: string[] = [];

  try {
    const redemption = await prisma.$transaction(async (tx) => {
      // Read voucher via Prisma ORM (uses @map mapping; safe across schema
      // drift). Concurrency for stock is handled by the slot reservation
      // below — only one redemption can claim a given AVAILABLE slot, so we
      // cannot oversell even without explicit FOR UPDATE.
      const voucher = await tx.voucher.findUnique({
        where: { id: voucherId },
        select: {
          id: true,
          remainingStock: true,
          isActive: true,
          expiryDate: true,
          basePrice: true,
          qrPerSlot: true,
          merchantId: true,
        },
      });

      if (!voucher) throw new Error("Voucher not found");
      if (!voucher.isActive) throw new Error("Voucher is not active");
      if (voucher.remainingStock <= 0) throw new Error("Voucher out of stock");
      // Voucher is valid through the entire expiry day in WIB (UTC+7)
      const expiryEnd = new Date(voucher.expiryDate);
      expiryEnd.setUTCHours(16, 59, 59, 999); // 23:59:59 WIB = 16:59:59 UTC
      if (expiryEnd < new Date()) throw new Error("Voucher expired");

      const qrPerRedemption = voucher.qrPerSlot;

      // Find an available slot first (before generating QR images)
      const availableSlot = await tx.redemptionSlot.findFirst({
        where: { voucherId, status: "AVAILABLE" },
        include: { qrCodes: { orderBy: { qrNumber: "asc" } } },
      });

      if (!availableSlot || availableSlot.qrCodes.length === 0) {
        throw new Error("No available QR codes in slots");
      }
      if (availableSlot.qrCodes.length !== qrPerRedemption) {
        throw new Error(
          `Slot has ${availableSlot.qrCodes.length} QR records but ${qrPerRedemption} were expected`
        );
      }

      // 3-component pricing: base + app fee + gas fee
      const basePrice = new Prisma.Decimal(voucher.basePrice);
      const appFee = basePrice.mul(appFeePercentage).div(100);
      const gasFee = new Prisma.Decimal(gasFeeIdr.toString());
      const totalIdr = basePrice.add(appFee).add(gasFee);

      // priceIdr here is the WEALTH token price fetched from CMC (closure from above)
      const wealthPriceDecimal = new Prisma.Decimal(priceIdr);
      const wealthAmount = totalIdr.div(wealthPriceDecimal);
      const appFeeAmount = appFee.div(wealthPriceDecimal);
      const gasFeeAmount = gasFee.div(wealthPriceDecimal);

      // Generate QR codes (R2 uploads — not rolled back by Prisma on failure)
      const qrData = await Promise.all(
        Array.from({ length: qrPerRedemption }, (_, i) =>
          generateQrCode(redemptionId, i + 1)
        )
      );
      uploadedImageUrls = qrData.map((q) => q.imageUrl);

      // Create redemption with pre-generated ID
      const newRedemption = await tx.redemption.create({
        data: {
          id: redemptionId,
          userEmail,
          voucherId,
          merchantId: voucher.merchantId,
          slotId: availableSlot.id,
          wealthAmount,
          priceIdrAtRedeem: Math.round(Number(voucher.basePrice)),
          wealthPriceIdrAtRedeem: wealthPriceDecimal,
          appFeeAmount,
          gasFeeAmount,
          idempotencyKey,
          status: "PENDING",
        },
      });

      // Update slot status to REDEEMED
      await tx.redemptionSlot.update({
        where: { id: availableSlot.id },
        data: { status: "REDEEMED" },
      });

      // Assign QR codes to this redemption and write the real R2 key from generateQrCode
      const now = new Date();
      await Promise.all(
        availableSlot.qrCodes.map((qr, i) =>
          tx.qrCode.update({
            where: { id: qr.id },
            data: {
              status: "REDEEMED",
              redemptionId: newRedemption.id,
              usedAt: now,
              token: qrData[i].token,
              imageUrl: qrData[i].imageUrl,
              imageHash: qrData[i].imageHash,
            },
          })
        )
      );

      return newRedemption;
    });

    return { redemption, alreadyExists: false };
  } catch (err) {
    // Compensating action: delete R2 files if any were uploaded before the DB failed
    if (uploadedImageUrls.length > 0) {
      await deleteQrFiles(uploadedImageUrls);
    }
    throw err;
  }
}

export async function confirmRedemption(txHash: string) {
  return prisma.$transaction(async (tx) => {
    // Find the pending redemption by txHash. The atomic update below guards
    // against double-confirmation: only one caller will succeed in flipping
    // status from PENDING to CONFIRMED.
    const redemption = await tx.redemption.findFirst({
      where: { txHash, status: "PENDING" },
      select: { id: true, voucherId: true },
    });

    if (!redemption) {
      throw new Error("Redemption not found or already processed");
    }

    const flipped = await tx.redemption.updateMany({
      where: { id: redemption.id, status: "PENDING" },
      data: { status: "CONFIRMED", confirmedAt: new Date() },
    });

    if (flipped.count === 0) {
      throw new Error("Redemption already confirmed by another worker");
    }

    const updated = await tx.redemption.findUniqueOrThrow({
      where: { id: redemption.id },
    });

    // Recalculate remainingStock from actual available slots instead of blind decrement
    const availableCount = await tx.redemptionSlot.count({
      where: { voucherId: redemption.voucherId, status: "AVAILABLE" },
    });

    await tx.voucher.update({
      where: { id: redemption.voucherId },
      data: { remainingStock: availableCount },
    });

    return updated;
  });
}

let cachedRpcClient: ReturnType<typeof createPublicClient> | null = null;

function getRpcClient() {
  if (cachedRpcClient) return cachedRpcClient;
  const rpcUrl = process.env.ALCHEMY_RPC_URL;
  if (!rpcUrl) return null;
  const { chain } = resolveChain();
  cachedRpcClient = createPublicClient({ chain, transport: http(rpcUrl) });
  return cachedRpcClient;
}

export type ReconcileOutcome =
  | { reconciled: true; status: "CONFIRMED" | "FAILED" }
  | { reconciled: false; reason: "no-tx-hash" | "no-receipt" | "no-rpc" | "not-pending" };

export async function reconcileRedemptionById(
  redemptionId: string,
): Promise<ReconcileOutcome> {
  const redemption = await prisma.redemption.findUnique({
    where: { id: redemptionId },
    select: { id: true, status: true, txHash: true },
  });

  if (!redemption) throw new Error("Redemption not found");
  if (redemption.status !== "PENDING") {
    return { reconciled: false, reason: "not-pending" };
  }
  if (!redemption.txHash) {
    return { reconciled: false, reason: "no-tx-hash" };
  }

  const client = getRpcClient();
  if (!client) return { reconciled: false, reason: "no-rpc" };

  try {
    const receipt = await client.getTransactionReceipt({
      hash: redemption.txHash as `0x${string}`,
    });
    if (!receipt) return { reconciled: false, reason: "no-receipt" };

    if (receipt.status === "success") {
      await confirmRedemption(redemption.txHash);
      return { reconciled: true, status: "CONFIRMED" };
    }
    await failRedemption(redemption.txHash);
    return { reconciled: true, status: "FAILED" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/could not be found|not found/i.test(msg)) {
      return { reconciled: false, reason: "no-receipt" };
    }
    throw err;
  }
}

// A PENDING redemption is considered stale (the user never broadcast a tx)
// after this window. The user-facing banner escalates to "contact support" at
// 15 min; 30 min gives ample buffer before we release the slot back to stock.
export const STALE_PENDING_EXPIRY_MS = 30 * 60 * 1000;

type FailableRedemption = {
  id: string;
  voucherId: string;
  qrCodes: { id: string; imageUrl: string | null; slotId: string }[];
};

/**
 * Shared core for transitioning a PENDING redemption to FAILED and releasing
 * its slot + QR codes back to AVAILABLE so the voucher stock recovers.
 *
 * QR codes are RESET (not deleted): they are pre-created per slot at voucher
 * creation and never regenerated, so deleting them would leave the slot
 * AVAILABLE-but-unredeemable ("No available QR codes in slots"). Resetting
 * keeps the slot reusable — initiateRedemption overwrites token/image on reuse.
 *
 * The status flip is guarded so a concurrent confirmation cannot be clobbered,
 * and R2 cleanup only runs once we've actually claimed the failure (otherwise a
 * confirmed redemption could lose its QR images).
 */
export async function failPendingRedemption(redemption: FailableRedemption) {
  const result = await prisma.$transaction(async (tx) => {
    const flipped = await tx.redemption.updateMany({
      where: { id: redemption.id, status: "PENDING" },
      data: { status: "FAILED", failedAt: new Date() },
    });
    if (flipped.count === 0) {
      // Already confirmed or failed by another worker — leave slots/QRs alone.
      return null;
    }

    const qrIds = redemption.qrCodes.map((q) => q.id);
    if (qrIds.length > 0) {
      await tx.qrCode.updateMany({
        where: { id: { in: qrIds } },
        data: {
          status: "AVAILABLE",
          redemptionId: null,
          usedAt: null,
          scannedById: null,
          imageUrl: null,
        },
      });
    }

    const slotIds = [...new Set(redemption.qrCodes.map((q) => q.slotId))];
    if (slotIds.length > 0) {
      await tx.redemptionSlot.updateMany({
        where: { id: { in: slotIds }, status: "REDEEMED" },
        data: { status: "AVAILABLE" },
      });
    }

    // Recalculate remainingStock from actual available slots
    const availableCount = await tx.redemptionSlot.count({
      where: { voucherId: redemption.voucherId, status: "AVAILABLE" },
    });
    await tx.voucher.update({
      where: { id: redemption.voucherId },
      data: { remainingStock: availableCount },
    });

    return tx.redemption.findUniqueOrThrow({ where: { id: redemption.id } });
  });

  // Best-effort R2 cleanup — only after we won the status flip, using the
  // image URLs loaded before they were nulled in the transaction above.
  if (result) {
    const imageUrls = redemption.qrCodes
      .map((q) => q.imageUrl)
      .filter(Boolean) as string[];
    if (imageUrls.length > 0) {
      try {
        await deleteQrFiles(imageUrls);
      } catch (err) {
        console.error("[failPendingRedemption] R2 cleanup failed, continuing:", err);
      }
    }
  }

  return result;
}

export async function failRedemption(txHash: string) {
  const redemption = await prisma.redemption.findFirst({
    where: { txHash, status: "PENDING" },
    select: {
      id: true,
      voucherId: true,
      qrCodes: { select: { id: true, imageUrl: true, slotId: true } },
    },
  });

  if (!redemption) throw new Error("Redemption not found");

  return failPendingRedemption(redemption);
}

/**
 * Sweep PENDING redemptions that never received a txHash (the user's wallet
 * transaction failed — e.g. insufficient gas — before broadcasting) and are
 * older than the stale window, marking them FAILED and releasing their slots.
 *
 * Bounded by `limit` so a single invocation can't run unbounded; callers that
 * need to drain everything should loop until `expired < limit`.
 */
export async function expireStalePendingRedemptions(opts?: {
  olderThanMs?: number;
  limit?: number;
}): Promise<{ expired: number; ids: string[] }> {
  const olderThanMs = opts?.olderThanMs ?? STALE_PENDING_EXPIRY_MS;
  const limit = opts?.limit ?? 100;
  const cutoff = new Date(Date.now() - olderThanMs);

  const stale = await prisma.redemption.findMany({
    where: { status: "PENDING", txHash: null, createdAt: { lt: cutoff } },
    select: {
      id: true,
      voucherId: true,
      qrCodes: { select: { id: true, imageUrl: true, slotId: true } },
    },
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  const ids: string[] = [];
  for (const redemption of stale) {
    try {
      const result = await failPendingRedemption(redemption);
      if (result) ids.push(redemption.id);
    } catch (err) {
      console.error(`[expireStalePendingRedemptions] ${redemption.id} failed:`, err);
    }
  }

  return { expired: ids.length, ids };
}
