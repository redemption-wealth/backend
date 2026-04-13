import { randomUUID } from "crypto";
import { prisma } from "../db.js";
import { Prisma } from "@prisma/client";
import { generateQrCode, deleteQrFiles } from "./qr-generator.js";

interface InitiateRedemptionParams {
  userId: string;
  voucherId: string;
  idempotencyKey: string;
  wealthPriceIdr: number;
}

export async function initiateRedemption({
  userId,
  voucherId,
  idempotencyKey,
  wealthPriceIdr,
}: InitiateRedemptionParams) {
  // Check idempotency (scoped to user)
  const existing = await prisma.redemption.findFirst({
    where: { idempotencyKey, userId },
  });
  if (existing) {
    return { redemption: existing, alreadyExists: true };
  }

  // Fetch app settings for app fee
  const settings = await prisma.appSettings.findUnique({
    where: { id: "singleton" },
  });
  const appFeePercentage = settings?.appFeePercentage ?? new Prisma.Decimal(3);

  // Fetch active gas fee setting
  const activeFee = await prisma.feeSetting.findFirst({
    where: { isActive: true },
  });
  const gasFeeIdr = activeFee?.amountIdr ?? 0;

  // Pre-generate redemptionId so we can use it for QR R2 keys before the transaction
  const redemptionId = randomUUID();

  // --- Transaction with row-level locking ---
  // We generate QR images outside the DB transaction (R2 is not transactional),
  // then insert everything atomically. On DB failure, we clean up R2 files.
  let uploadedImageUrls: string[] = [];

  try {
    const redemption = await prisma.$transaction(async (tx) => {
      // Lock voucher row
      const [voucher] = await tx.$queryRawUnsafe<
        Array<{
          id: string;
          remaining_stock: number;
          is_active: boolean;
          end_date: Date;
          price_idr: number;
          qr_per_redemption: number;
        }>
      >(
        `SELECT id, remaining_stock, is_active, end_date, price_idr, qr_per_redemption FROM vouchers WHERE id = $1 FOR UPDATE`,
        voucherId
      );

      if (!voucher) throw new Error("Voucher not found");
      if (!voucher.is_active) throw new Error("Voucher is not active");
      if (voucher.remaining_stock <= 0) throw new Error("Voucher out of stock");
      if (new Date(voucher.end_date) < new Date()) throw new Error("Voucher expired");

      const qrPerRedemption = voucher.qr_per_redemption;

      // 3-component pricing: base + app fee + gas fee
      const priceIdr = new Prisma.Decimal(voucher.price_idr);
      const appFee = priceIdr.mul(appFeePercentage).div(100);
      const gasFee = new Prisma.Decimal(gasFeeIdr);
      const totalIdr = priceIdr.add(appFee).add(gasFee);

      const wealthPriceDecimal = new Prisma.Decimal(wealthPriceIdr);
      const wealthAmount = totalIdr.div(wealthPriceDecimal);
      const appFeeAmount = appFee.div(wealthPriceDecimal);
      const gasFeeAmount = gasFee.div(wealthPriceDecimal);

      // Generate QR codes (R2 uploads happen inside the tx callback but are not rolled back
      // by Prisma — we handle cleanup ourselves in the catch block below)
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
          userId,
          voucherId,
          wealthAmount,
          priceIdrAtRedeem: voucher.price_idr,
          wealthPriceIdrAtRedeem: wealthPriceDecimal,
          appFeeAmount,
          gasFeeAmount,
          idempotencyKey,
          status: "pending",
        },
      });

      // Insert QR code records
      await tx.qrCode.createMany({
        data: qrData.map((q) => ({
          voucherId,
          redemptionId: newRedemption.id,
          token: q.token,
          imageUrl: q.imageUrl,
          imageHash: q.imageHash,
          status: "assigned" as const,
          assignedToUserId: userId,
          assignedAt: new Date(),
        })),
      });

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
    const redemption = await tx.redemption.findFirst({
      where: { txHash, status: "pending" },
    });

    if (!redemption) throw new Error("Redemption not found or already processed");

    const updated = await tx.redemption.update({
      where: { id: redemption.id },
      data: { status: "confirmed", confirmedAt: new Date() },
    });

    await tx.voucher.update({
      where: { id: redemption.voucherId },
      data: { remainingStock: { decrement: 1 } },
    });

    await tx.transaction.create({
      data: {
        userId: redemption.userId,
        redemptionId: redemption.id,
        type: "redeem",
        amountWealth: redemption.wealthAmount,
        txHash,
        status: "confirmed",
        confirmedAt: new Date(),
      },
    });

    return updated;
  });
}

export async function failRedemption(txHash: string) {
  // Load QR records outside transaction so we have imageUrls for R2 cleanup
  const redemption = await prisma.redemption.findFirst({
    where: { txHash, status: "pending" },
    include: { qrCodes: { select: { id: true, imageUrl: true } } },
  });

  if (!redemption) throw new Error("Redemption not found");

  // Attempt R2 cleanup first (best-effort — don't let R2 errors block DB update)
  const imageUrls = redemption.qrCodes
    .map((q) => q.imageUrl)
    .filter((url): url is string => Boolean(url));
  if (imageUrls.length > 0) {
    try {
      await deleteQrFiles(imageUrls);
    } catch (err) {
      console.error("[failRedemption] R2 cleanup failed, continuing:", err);
    }
  }

  // DB transaction: delete QR records + mark redemption as failed
  return prisma.$transaction(async (tx) => {
    const qrIds = redemption.qrCodes.map((q) => q.id);
    if (qrIds.length > 0) {
      await tx.qrCode.deleteMany({ where: { id: { in: qrIds } } });
    }

    return tx.redemption.update({
      where: { id: redemption.id },
      data: { status: "failed" },
    });
  });
}
