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
  // Check idempotency
  const existing = await prisma.redemption.findUnique({
    where: { idempotencyKey },
  });
  if (existing) {
    return { redemption: existing, alreadyExists: true };
  }

  // Fetch app settings for dev cut
  const settings = await prisma.appSettings.findUnique({
    where: { id: "singleton" },
  });
  const devCutPercentage =
    settings?.devCutPercentage ?? new Prisma.Decimal(3);

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
      }>
    >(
      `SELECT id, remaining_stock, is_active, end_date, price_idr FROM vouchers WHERE id = $1 FOR UPDATE`,
      voucherId
    );

    if (!voucher) throw new Error("Voucher not found");
    if (!voucher.is_active) throw new Error("Voucher is not active");
    if (voucher.remaining_stock <= 0) throw new Error("Voucher out of stock");
    if (new Date(voucher.end_date) < new Date())
      throw new Error("Voucher expired");

    // Lock first available QR code (FIFO)
    const [qrCode] = await tx.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id FROM qr_codes WHERE voucher_id = $1 AND status = 'available' ORDER BY created_at ASC LIMIT 1 FOR UPDATE`,
      voucherId
    );

    if (!qrCode) throw new Error("No QR codes available");

    // Calculate amounts
    const wealthAmount = new Prisma.Decimal(voucher.price_idr).div(
      new Prisma.Decimal(wealthPriceIdr)
    );
    const devCutAmount = wealthAmount.mul(devCutPercentage).div(100);

    // Create redemption (pending — waiting for on-chain tx)
    const newRedemption = await tx.redemption.create({
      data: {
        userId,
        voucherId,
        qrCodeId: qrCode.id,
        wealthAmount,
        priceIdrAtRedeem: voucher.price_idr,
        wealthPriceIdrAtRedeem: new Prisma.Decimal(wealthPriceIdr),
        devCutAmount,
        idempotencyKey,
        status: "pending",
      },
    });

    // Assign QR to user
    await tx.qrCode.update({
      where: { id: qrCode.id },
      data: {
        status: "assigned",
        assignedToUserId: userId,
        assignedAt: new Date(),
      },
    });

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
    });

    if (!redemption) throw new Error("Redemption not found");

    // Fail redemption
    await tx.redemption.update({
      where: { id: redemption.id },
      data: { status: "failed" },
    });

    // Release QR back to available
    await tx.qrCode.update({
      where: { id: redemption.qrCodeId },
      data: {
        status: "available",
        assignedToUserId: null,
        assignedAt: null,
      },
    });

    return redemption;
  });
}
