import { randomUUID } from "crypto";
import { prisma } from "../db.js";
import { Prisma } from "@prisma/client";
import { createPublicClient, http } from "viem";
import { mainnet, sepolia } from "viem/chains";
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
      // Lock voucher row
      const [voucher] = await tx.$queryRawUnsafe<
        Array<{
          id: string;
          remaining_stock: number;
          is_active: boolean;
          expiry_date: Date;
          base_price: string;
          qr_per_slot: number;
          merchant_id: string;
        }>
      >(
        `SELECT id, remaining_stock, is_active, expiry_date, base_price, qr_per_slot, merchant_id FROM vouchers WHERE id = $1 FOR UPDATE`,
        voucherId
      );

      if (!voucher) throw new Error("Voucher not found");
      if (!voucher.is_active) throw new Error("Voucher is not active");
      if (voucher.remaining_stock <= 0) throw new Error("Voucher out of stock");
      // Voucher is valid through the entire expiry day in WIB (UTC+7)
      const expiryEnd = new Date(voucher.expiry_date);
      expiryEnd.setUTCHours(16, 59, 59, 999); // 23:59:59 WIB = 16:59:59 UTC
      if (expiryEnd < new Date()) throw new Error("Voucher expired");

      const qrPerRedemption = voucher.qr_per_slot;

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
      const priceIdr = new Prisma.Decimal(voucher.base_price);
      const appFee = priceIdr.mul(appFeePercentage).div(100);
      const gasFee = new Prisma.Decimal(gasFeeIdr.toString());
      const totalIdr = priceIdr.add(appFee).add(gasFee);

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
          merchantId: voucher.merchant_id,
          slotId: availableSlot.id,
          wealthAmount,
          priceIdrAtRedeem: Math.round(Number(voucher.base_price)),
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
    // Lock the redemption row to prevent double-confirmation race condition
    const [redemption] = await tx.$queryRawUnsafe<
      Array<{ id: string; voucher_id: string; wealth_amount: string; status: string }>
    >(
      `SELECT id, voucher_id, wealth_amount, status FROM redemptions WHERE tx_hash = $1 FOR UPDATE`,
      txHash
    );

    if (!redemption || redemption.status !== "PENDING") {
      throw new Error("Redemption not found or already processed");
    }

    const updated = await tx.redemption.update({
      where: { id: redemption.id },
      data: { status: "CONFIRMED", confirmedAt: new Date() },
    });

    // Recalculate remainingStock from actual available slots instead of blind decrement
    const availableCount = await tx.redemptionSlot.count({
      where: { voucherId: redemption.voucher_id, status: "AVAILABLE" },
    });

    await tx.voucher.update({
      where: { id: redemption.voucher_id },
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
  const chainId = Number(process.env.ETHEREUM_CHAIN_ID ?? 1);
  const chain = chainId === sepolia.id ? sepolia : mainnet;
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

export async function failRedemption(txHash: string) {
  // Load QR records outside transaction so we have imageUrls for R2 cleanup
  const redemption = await prisma.redemption.findFirst({
    where: { txHash, status: "PENDING" },
    include: { qrCodes: { select: { id: true, imageUrl: true, slotId: true } } },
  });

  if (!redemption) throw new Error("Redemption not found");

  // Attempt R2 cleanup first (best-effort)
  const imageUrls = redemption.qrCodes.map((q) => q.imageUrl).filter(Boolean) as string[];
  if (imageUrls.length > 0) {
    try {
      await deleteQrFiles(imageUrls);
    } catch (err) {
      console.error("[failRedemption] R2 cleanup failed, continuing:", err);
    }
  }

  // Collect unique slot IDs to restore
  const slotIds = [...new Set(redemption.qrCodes.map((q) => q.slotId))];

  // DB transaction: delete QR records, restore slot, recalculate stock, mark failed
  return prisma.$transaction(async (tx) => {
    const qrIds = redemption.qrCodes.map((q) => q.id);
    if (qrIds.length > 0) {
      await tx.qrCode.deleteMany({ where: { id: { in: qrIds } } });
    }

    // Restore slot(s) back to AVAILABLE
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

    return tx.redemption.update({
      where: { id: redemption.id },
      data: { status: "FAILED", failedAt: new Date() },
    });
  });
}
