import { randomUUID } from "crypto";
import { prisma } from "../db.js";
import { Prisma } from "@prisma/client";
import { deleteQrFiles, generateAndUploadQrImage, deleteQrImage } from "./qr-generator.js";

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
  // 1. Check idempotency (scoped to user)
  const existing = await prisma.redemption.findFirst({
    where: { idempotencyKey, userId },
    include: { qrCodes: true },
  });
  if (existing) {
    return { redemption: existing, qrCodes: existing.qrCodes, alreadyExists: true };
  }

  // 2. Lock and validate voucher
  const voucher = await prisma.voucher.findUnique({
    where: { id: voucherId },
  });

  if (!voucher) throw new Error("Voucher not found");
  if (!voucher.isActive) throw new Error("Voucher is not active");
  if (new Date() > voucher.endDate) throw new Error("Voucher has expired");

  // 3. Check available QR codes
  const availableQrCount = await prisma.qrCode.count({
    where: { voucherId, status: "available" }
  });

  const requiredQr = voucher.qrPerRedemption;

  if (availableQrCount < requiredQr) {
    throw new Error(
      `Not enough QR codes available. Required: ${requiredQr}, Available: ${availableQrCount}`
    );
  }

  // 4. Calculate pricing (3-component: base + app fee + gas fee)
  const settings = await prisma.appSettings.findUnique({
    where: { id: "singleton" },
  });
  const appFeePercentage = settings?.appFeePercentage ?? new Prisma.Decimal(3);

  const activeFee = await prisma.feeSetting.findFirst({
    where: { isActive: true },
  });
  const gasFeeIdr = activeFee?.amountIdr ?? 0;

  const priceIdr = new Prisma.Decimal(voucher.priceIdr);
  const appFee = priceIdr.mul(appFeePercentage).div(100);
  const gasFee = new Prisma.Decimal(gasFeeIdr);
  const totalIdr = priceIdr.add(appFee).add(gasFee);

  const wealthPriceDecimal = new Prisma.Decimal(wealthPriceIdr);
  const wealthAmount = totalIdr.div(wealthPriceDecimal);
  const appFeeAmount = appFee.div(wealthPriceDecimal);
  const gasFeeAmount = gasFee.div(wealthPriceDecimal);

  // 5. Transaction: Create redemption + Assign QR codes
  const result = await prisma.$transaction(async (tx) => {
    // Create redemption
    const redemption = await tx.redemption.create({
      data: {
        userId,
        voucherId,
        status: "pending",
        wealthAmount,
        appFeeAmount,
        gasFeeAmount,
        priceIdrAtRedeem: voucher.priceIdr,
        wealthPriceIdrAtRedeem: wealthPriceDecimal,
        idempotencyKey,
      },
    });

    // Find available QR codes (FIFO)
    const qrCodes = await tx.qrCode.findMany({
      where: { voucherId, status: "available" },
      take: requiredQr,
      orderBy: { createdAt: "asc" },
    });

    // Assign QR codes to user
    await tx.qrCode.updateMany({
      where: { id: { in: qrCodes.map(qr => qr.id) } },
      data: {
        status: "assigned",
        assignedToUserId: userId,
        redemptionId: redemption.id,
        assignedAt: new Date(),
      },
    });

    return { redemption, qrCodes };
  });

  // 6. Lazy-load: Generate QR images (outside transaction, can retry on failure)
  const qrCodesWithImages = await Promise.all(
    result.qrCodes.map(async (qr) => {
      try {
        const { imageUrl, imageHash } = await generateAndUploadQrImage(
          voucherId,
          qr.id,
          qr.token
        );

        await prisma.qrCode.update({
          where: { id: qr.id },
          data: { imageUrl, imageHash },
        });

        return { ...qr, imageUrl, imageHash };
      } catch (err) {
        console.error(`[initiateRedemption] Image generation failed for QR ${qr.id}:`, err);
        // Return QR without image (can be retried later)
        return qr;
      }
    })
  );

  // 7. Return redemption data
  const treasuryAddress = settings?.treasuryWalletAddress;
  const tokenAddress = settings?.tokenContractAddress;

  return {
    redemption: result.redemption,
    qrCodes: qrCodesWithImages,
    alreadyExists: false,
    txDetails: {
      tokenContractAddress: tokenAddress,
      treasuryWalletAddress: treasuryAddress,
      wealthAmount: wealthAmount.toString(),
    },
  };
}

export async function confirmRedemption(txHash: string) {
  const redemption = await prisma.redemption.findFirst({
    where: { txHash, status: "pending" },
  });

  if (!redemption) return; // Idempotent: already processed

  await prisma.$transaction(async (tx) => {
    // Update redemption status
    await tx.redemption.update({
      where: { id: redemption.id },
      data: {
        status: "confirmed",
        confirmedAt: new Date(),
      },
    });

    // Increment voucher usedStock (track confirmed redemptions)
    await tx.voucher.update({
      where: { id: redemption.voucherId },
      data: {
        usedStock: { increment: 1 },
        remainingStock: { decrement: 1 }
      },
    });

    // Create transaction record
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
  });
}

export async function failRedemption(txHash: string) {
  const redemption = await prisma.redemption.findFirst({
    where: { txHash, status: "pending" },
    include: { qrCodes: true },
  });

  if (!redemption) return; // Idempotent: already processed

  // Delete QR images from R2 (best-effort, non-blocking)
  await Promise.all(
    redemption.qrCodes.map(async (qr) => {
      if (qr.imageUrl) {
        await deleteQrImage(qr.imageUrl);
      }
    })
  );

  // Recycle QR codes: assigned → available
  await prisma.$transaction(async (tx) => {
    await tx.qrCode.updateMany({
      where: { redemptionId: redemption.id },
      data: {
        status: "available",
        assignedToUserId: null,
        redemptionId: null,
        assignedAt: null,
        imageUrl: null,
        imageHash: null,
      },
    });

    await tx.redemption.update({
      where: { id: redemption.id },
      data: { status: "failed" },
    });
  });
}
