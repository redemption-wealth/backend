import { prisma } from "../db.js";
import { Prisma } from "@prisma/client";

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
  const appFeePercentage =
    settings?.appFeePercentage ?? new Prisma.Decimal(3);

  // Fetch active gas fee setting
  const activeFee = await prisma.feeSetting.findFirst({
    where: { isActive: true },
  });
  const gasFeeIdr = activeFee?.amountIdr ?? 0;

  // Transaction with row-level locking
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
    if (new Date(voucher.end_date) < new Date())
      throw new Error("Voucher expired");

    const qrPerRedemption = voucher.qr_per_redemption;

    // Lock available QR codes (FIFO)
    const qrCodes = await tx.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id FROM qr_codes WHERE voucher_id = $1 AND status = 'available' ORDER BY created_at ASC LIMIT $2 FOR UPDATE`,
      voucherId,
      qrPerRedemption
    );

    if (qrCodes.length === 0) throw new Error("No QR codes available");
    if (qrCodes.length < qrPerRedemption)
      throw new Error("Not enough QR codes available");

    // 3-component pricing: base + app fee + gas fee
    const priceIdr = new Prisma.Decimal(voucher.price_idr);
    const appFee = priceIdr.mul(appFeePercentage).div(100);
    const gasFee = new Prisma.Decimal(gasFeeIdr);
    const totalIdr = priceIdr.add(appFee).add(gasFee);

    const wealthPriceDecimal = new Prisma.Decimal(wealthPriceIdr);
    const wealthAmount = totalIdr.div(wealthPriceDecimal);
    const appFeeAmount = appFee.div(wealthPriceDecimal);
    const gasFeeAmount = gasFee.div(wealthPriceDecimal);

    // Create redemption (pending — waiting for on-chain tx)
    const newRedemption = await tx.redemption.create({
      data: {
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

    // Assign QR codes to user and link to redemption
    for (const qr of qrCodes) {
      await tx.qrCode.update({
        where: { id: qr.id },
        data: {
          status: "assigned",
          assignedToUserId: userId,
          assignedAt: new Date(),
          redemptionId: newRedemption.id,
        },
      });
    }

    return newRedemption;
  });

  return { redemption, alreadyExists: false };
}

export async function confirmRedemption(txHash: string) {
  return prisma.$transaction(async (tx) => {
    const redemption = await tx.redemption.findFirst({
      where: { txHash, status: "pending" },
    });

    if (!redemption)
      throw new Error("Redemption not found or already processed");

    // Confirm redemption
    const updated = await tx.redemption.update({
      where: { id: redemption.id },
      data: { status: "confirmed", confirmedAt: new Date() },
    });

    // Decrement voucher stock
    await tx.voucher.update({
      where: { id: redemption.voucherId },
      data: { remainingStock: { decrement: 1 } },
    });

    // Create transaction ledger entry
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
  return prisma.$transaction(async (tx) => {
    const redemption = await tx.redemption.findFirst({
      where: { txHash, status: "pending" },
      include: { qrCodes: true },
    });

    if (!redemption) throw new Error("Redemption not found");

    // Fail redemption
    await tx.redemption.update({
      where: { id: redemption.id },
      data: { status: "failed" },
    });

    // Release all QR codes back to available
    for (const qr of redemption.qrCodes) {
      await tx.qrCode.update({
        where: { id: qr.id },
        data: {
          status: "available",
          assignedToUserId: null,
          assignedAt: null,
          redemptionId: null,
        },
      });
    }

    return redemption;
  });
}
