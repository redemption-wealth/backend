import { prisma } from "../db.js";
import { Prisma } from "@prisma/client";
import { createPublicClient, http } from "viem";
import { resolveChain } from "../lib/chain.js";
import { generateQrCode, generateUploadedAsset, deleteQrFiles } from "./qr-generator.js";
import { getWealthPrice } from "./price.js";
import type { VoucherFormat, BarcodeSymbology } from "./asset-values.js";

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

  // Reserve a slot in a transaction. QR codes are NOT touched here — they are
  // generated and handed to the user only once the on-chain transfer is
  // confirmed (see confirmRedemption). A failed/abandoned attempt therefore
  // leaves no QR and no history: the PENDING row is deleted on release.
  const redemption = await prisma.$transaction(async (tx) => {
    const voucher = await tx.voucher.findUnique({
      where: { id: voucherId },
      select: {
        id: true,
        remainingStock: true,
        isActive: true,
        startDate: true,
        expiryDate: true,
        basePrice: true,
        qrPerSlot: true,
        merchantId: true,
      },
    });

    if (!voucher) throw new Error("Voucher not found");
    if (!voucher.isActive) throw new Error("Voucher is not active");
    // Block redeeming "Akan Datang" vouchers before their start day (WIB).
    const startDay = new Date(voucher.startDate);
    startDay.setUTCHours(-7, 0, 0, 0); // 00:00 WIB = 17:00 UTC previous day
    if (startDay > new Date()) throw new Error("Voucher is not active yet");
    if (voucher.remainingStock <= 0) throw new Error("Voucher out of stock");
    // Voucher is valid through the entire expiry day in WIB (UTC+7)
    const expiryEnd = new Date(voucher.expiryDate);
    expiryEnd.setUTCHours(16, 59, 59, 999); // 23:59:59 WIB = 16:59:59 UTC
    if (expiryEnd < new Date()) throw new Error("Voucher expired");

    const qrPerRedemption = voucher.qrPerSlot;

    // Reserve an available slot. Only one redemption can claim a given slot, so
    // we cannot oversell even without an explicit FOR UPDATE.
    const availableSlot = await tx.redemptionSlot.findFirst({
      where: { voucherId, status: "AVAILABLE" },
      include: { qrCodes: { orderBy: { qrNumber: "asc" } } },
    });

    if (!availableSlot || availableSlot.qrCodes.length === 0) {
      throw new Error("No available QR codes in slots");
    }
    if (availableSlot.qrCodes.length !== qrPerRedemption) {
      throw new Error(
        `Slot has ${availableSlot.qrCodes.length} QR records but ${qrPerRedemption} were expected`,
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

    const newRedemption = await tx.redemption.create({
      data: {
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

    // Hold the slot. QR codes stay AVAILABLE until confirmation.
    await tx.redemptionSlot.update({
      where: { id: availableSlot.id },
      data: { status: "REDEEMED" },
    });

    return newRedemption;
  });

  return { redemption, alreadyExists: false };
}

/**
 * Generate + assign the slot's QR codes to a CONFIRMED redemption. Idempotent:
 * deterministic R2 keys and an already-assigned check make it safe to call
 * repeatedly, so it doubles as a lazy-heal if QR generation failed right after
 * confirmation (e.g. R2 was briefly down).
 */
export async function ensureQrAssigned(redemptionId: string): Promise<void> {
  const redemption = await prisma.redemption.findUnique({
    where: { id: redemptionId },
    select: {
      status: true,
      voucher: {
        select: { format: true, assetSource: true, barcodeSymbology: true },
      },
      slot: {
        select: {
          qrCodes: {
            select: { id: true, qrNumber: true, value: true, redemptionId: true },
            orderBy: { qrNumber: "asc" },
          },
        },
      },
    },
  });
  if (!redemption || redemption.status !== "CONFIRMED" || !redemption.slot) return;

  const qrRecords = redemption.slot.qrCodes;
  if (qrRecords.length === 0) return;
  if (qrRecords.every((q) => q.redemptionId === redemptionId)) return; // already assigned

  const now = new Date();

  if (redemption.voucher.assetSource === "MERCHANT_UPLOADED") {
    // Render each slot's pre-stored value (CODE → no image). The value is never
    // regenerated; only the rendered image + assignment metadata are written.
    const format = redemption.voucher.format as VoucherFormat;
    const symbology = redemption.voucher.barcodeSymbology as BarcodeSymbology | null;
    const rendered = await Promise.all(
      qrRecords.map((qr) =>
        generateUploadedAsset(redemptionId, qr.qrNumber, {
          format,
          value: qr.value ?? "",
          symbology,
        }),
      ),
    );
    await prisma.$transaction(
      qrRecords.map((qr, i) =>
        prisma.qrCode.update({
          where: { id: qr.id },
          data: {
            status: "REDEEMED",
            redemptionId,
            assignedAt: now,
            imageUrl: rendered[i].imageUrl, // null for CODE
            // imageHash is @unique NOT NULL — keep the placeholder for CODE.
            ...(rendered[i].imageHash ? { imageHash: rendered[i].imageHash } : {}),
          },
        }),
      ),
    );
    return;
  }

  // Wealth-generated flow (unchanged): mint a token + render a QR per record.
  // R2 uploads happen outside the DB transaction (network calls).
  const qrData = await Promise.all(
    qrRecords.map((qr) => generateQrCode(redemptionId, qr.qrNumber)),
  );
  await prisma.$transaction(
    qrRecords.map((qr, i) =>
      prisma.qrCode.update({
        where: { id: qr.id },
        data: {
          status: "REDEEMED",
          redemptionId,
          assignedAt: now,
          token: qrData[i].token,
          imageUrl: qrData[i].imageUrl,
          imageHash: qrData[i].imageHash,
        },
      }),
    ),
  );
}

export async function confirmRedemption(txHash: string) {
  // Claim the confirmation atomically — only one worker proceeds past this,
  // so a concurrent webhook + reconcile cannot double-assign QR codes.
  const target = await prisma.redemption.findFirst({
    where: { txHash, status: "PENDING" },
    select: { id: true, voucherId: true },
  });
  if (!target) throw new Error("Redemption not found or already processed");

  const claimed = await prisma.redemption.updateMany({
    where: { id: target.id, status: "PENDING" },
    data: { status: "CONFIRMED", confirmedAt: new Date() },
  });
  if (claimed.count === 0) {
    throw new Error("Redemption already confirmed by another worker");
  }

  // Transfer confirmed → generate + hand over the QR codes. If QR generation
  // fails (e.g. R2 briefly down) the confirmation still stands; the QR is
  // lazily healed on the next detail fetch via ensureQrAssigned.
  try {
    await ensureQrAssigned(target.id);
  } catch (err) {
    console.error("[confirmRedemption] QR assignment deferred:", err);
  }

  // Recalculate remainingStock from actual available slots.
  const availableCount = await prisma.redemptionSlot.count({
    where: { voucherId: target.voucherId, status: "AVAILABLE" },
  });
  await prisma.voucher.update({
    where: { id: target.voucherId },
    data: { remainingStock: availableCount },
  });

  return prisma.redemption.findUniqueOrThrow({ where: { id: target.id } });
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

/**
 * Release a PENDING redemption: free its reserved slot and DELETE the row so a
 * failed/abandoned attempt leaves no history (product decision). Deleting the
 * row also frees the unique `slotId`, so the slot can be reserved again — this
 * is what fixes the "Unique constraint failed on slotId" lockout.
 *
 * Guarded so a concurrent confirmation is never clobbered (only acts while
 * still PENDING). Returns true if it released the redemption.
 */
export async function releasePendingRedemption(
  redemptionId: string,
): Promise<boolean> {
  // Collect any assigned QR image keys up-front for best-effort R2 cleanup
  // (only transition-era pendings have these; new-flow pendings have none).
  const pre = await prisma.redemption.findUnique({
    where: { id: redemptionId },
    select: { status: true, qrCodes: { select: { imageUrl: true } } },
  });
  if (!pre || pre.status !== "PENDING") return false;
  const imageUrls = pre.qrCodes
    .map((q) => q.imageUrl)
    .filter(Boolean) as string[];

  const released = await prisma.$transaction(async (tx) => {
    // Re-check inside the tx so we don't clobber a concurrent confirmation.
    const current = await tx.redemption.findUnique({
      where: { id: redemptionId },
      select: { status: true, voucherId: true, slotId: true },
    });
    if (!current || current.status !== "PENDING") return false;

    // Detach any assigned QR codes back to AVAILABLE (no-op in the normal flow,
    // where a PENDING redemption never has QR codes assigned). NOTE: `value` is
    // deliberately NOT reset — a merchant-uploaded value is bound to its slot at
    // creation and must survive release so the slot can be reused as-is.
    await tx.qrCode.updateMany({
      where: { redemptionId },
      data: {
        status: "AVAILABLE",
        redemptionId: null,
        assignedAt: null,
        usedAt: null,
        scannedById: null,
        imageUrl: null,
      },
    });

    // Free the reserved slot.
    await tx.redemptionSlot.updateMany({
      where: { id: current.slotId, status: "REDEEMED" },
      data: { status: "AVAILABLE" },
    });

    // Delete the redemption — no failure history.
    await tx.redemption.delete({ where: { id: redemptionId } });

    const availableCount = await tx.redemptionSlot.count({
      where: { voucherId: current.voucherId, status: "AVAILABLE" },
    });
    await tx.voucher.update({
      where: { id: current.voucherId },
      data: { remainingStock: availableCount },
    });
    return true;
  });

  if (released && imageUrls.length > 0) {
    try {
      await deleteQrFiles(imageUrls);
    } catch (err) {
      console.error("[releasePendingRedemption] R2 cleanup failed:", err);
    }
  }
  return released;
}

export async function failRedemption(txHash: string) {
  const redemption = await prisma.redemption.findFirst({
    where: { txHash, status: "PENDING" },
    select: { id: true },
  });
  if (!redemption) throw new Error("Redemption not found");
  return releasePendingRedemption(redemption.id);
}

/**
 * Sweep PENDING redemptions that never received a txHash (the user's wallet
 * transaction failed — e.g. insufficient gas — before broadcasting) and are
 * older than the stale window, deleting them and releasing their slots.
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
    select: { id: true },
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  const ids: string[] = [];
  for (const redemption of stale) {
    try {
      const released = await releasePendingRedemption(redemption.id);
      if (released) ids.push(redemption.id);
    } catch (err) {
      console.error(`[expireStalePendingRedemptions] ${redemption.id} failed:`, err);
    }
  }

  return { expired: ids.length, ids };
}
