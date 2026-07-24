/**
 * DEMO SEED — populates the TEST database with every redemption-reliability
 * state so the new back-office Transaksi page can be reviewed visually.
 * REFUSES to run against anything that is not the TEST project / localhost.
 */
import "dotenv/config";
import { randomBytes } from "crypto";
import { prisma } from "../src/db.js";
import { Prisma } from "@prisma/client";

const url = process.env.DATABASE_URL ?? "";
if (!/ulncvbzreqtrfbkfrjrh|localhost|127\.0\.0\.1/.test(url)) {
  throw new Error("SAFETY: demo seed only runs against the TEST project or localhost");
}

const hex = (n: number) => randomBytes(n).toString("hex");
const tx = () => `0x${hex(32)}`;
const wallet = () => `0x${hex(20)}`;

async function slotWithQrs(voucherId: string, slotIndex: number, status: "AVAILABLE" | "REDEEMED" = "REDEEMED") {
  const slot = await prisma.redemptionSlot.create({
    data: { voucherId, slotIndex, status },
  });
  await prisma.qrCode.createMany({
    data: [1, 2].map((qrNumber) => ({
      voucherId,
      slotId: slot.id,
      qrNumber,
      token: `demo-${hex(12)}`,
      imageHash: `demo-${hex(12)}`,
      value: `DEMO-${slotIndex}-${qrNumber}-${hex(3).toUpperCase()}`,
    })),
  });
  return slot;
}

async function main() {
  const merchant = await prisma.merchant.create({
    data: { name: "Pekangembiraria (DEMO)", category: "Music Event" },
  });
  const voucher = await prisma.voucher.create({
    data: {
      merchantId: merchant.id,
      title: "PGR Tasikmalaya VIP (DEMO)",
      description: "Voucher demo untuk review halaman Transaksi",
      basePrice: new Prisma.Decimal(300000),
      totalStock: 8,
      remainingStock: 8,
      qrPerSlot: 2,
      format: "BARCODE",
      assetSource: "MERCHANT_UPLOADED",
      assetInputType: "VALUE",
      barcodeSymbology: "CODE128",
      appFeeSnapshot: new Prisma.Decimal("0.7"),
      gasFeeSnapshot: new Prisma.Decimal(500),
      startDate: new Date("2026-07-01"),
      expiryDate: new Date("2026-08-31"),
      isActive: true,
    },
  });

  const base = {
    voucherId: voucher.id,
    merchantId: merchant.id,
    priceIdrAtRedeem: 300000,
    wealthPriceIdrAtRedeem: new Prisma.Decimal("2004425.1413"),
    appFeeAmount: new Prisma.Decimal("0.001"),
    gasFeeAmount: new Prisma.Decimal("0.00025"),
  };
  const AMOUNT = new Prisma.Decimal("0.1509659771120788");

  // 1. CONFIRMED — normal success
  const w1 = wallet();
  await prisma.redemption.create({
    data: {
      ...base,
      userEmail: "budi.demo@gmail.com",
      slotId: (await slotWithQrs(voucher.id, 1)).id,
      wealthAmount: AMOUNT,
      walletAddress: w1,
      txHash: tx(),
      idempotencyKey: `demo-${hex(8)}`,
      status: "CONFIRMED",
      confirmedAt: new Date(Date.now() - 60 * 60 * 1000),
      createdAt: new Date(Date.now() - 61 * 60 * 1000),
    },
  });

  // 2. PENDING dengan txHash — tombol "Cek ulang on-chain" terlihat
  await prisma.redemption.create({
    data: {
      ...base,
      userEmail: "citra.demo@gmail.com",
      slotId: (await slotWithQrs(voucher.id, 2)).id,
      wealthAmount: AMOUNT,
      walletAddress: wallet(),
      txHash: tx(),
      idempotencyKey: `demo-${hex(8)}`,
      status: "PENDING",
      createdAt: new Date(Date.now() - 5 * 60 * 1000),
    },
  });

  // 3. EXPIRED — riwayat jujur, slot sudah dilepas (slotId null)
  await prisma.redemption.create({
    data: {
      ...base,
      userEmail: "dodi.demo@gmail.com",
      slotId: null,
      wealthAmount: AMOUNT,
      walletAddress: wallet(),
      idempotencyKey: `demo-${hex(8)}`,
      status: "EXPIRED",
      failedAt: new Date(Date.now() - 30 * 60 * 1000),
      createdAt: new Date(Date.now() - 65 * 60 * 1000),
    },
  });

  // 4. REFUNDED — dengan bukti tx refund
  await prisma.redemption.create({
    data: {
      ...base,
      userEmail: "eka.demo@gmail.com",
      slotId: null,
      wealthAmount: AMOUNT,
      walletAddress: wallet(),
      txHash: tx(),
      refundTxHash: tx(),
      refundedAt: new Date(Date.now() - 10 * 60 * 1000),
      idempotencyKey: `demo-${hex(8)}`,
      status: "REFUNDED",
      createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
    },
  });

  // 5. Kasus antrian: user dengan DUA pending tanpa txHash, amount sama →
  //    transfer masuk jadi ambigu → OPEN dengan 2 kandidat "jumlah cocok".
  const ambiguousWallet = wallet();
  await prisma.appUser.create({
    data: {
      privyId: `demo-privy-${hex(6)}`,
      email: "raka.demo@gmail.com",
      walletAddress: ambiguousWallet,
      referralCode: `demo-${hex(4)}`,
    },
  });
  for (const idx of [3, 4]) {
    await prisma.redemption.create({
      data: {
        ...base,
        userEmail: "raka.demo@gmail.com",
        slotId: (await slotWithQrs(voucher.id, idx)).id,
        wealthAmount: AMOUNT,
        walletAddress: ambiguousWallet,
        idempotencyKey: `demo-${hex(8)}`,
        status: "PENDING",
        createdAt: new Date(Date.now() - 20 * 60 * 1000),
      },
    });
  }
  await prisma.unmatchedTransfer.create({
    data: {
      txHash: tx(),
      fromAddress: ambiguousWallet,
      toAddress: "0x1fb56441c55e3730f9f5c43d94a5ff21ecfafe01",
      tokenAddress: "0xafa702c0a2a3a0cf1bd09435db61c913ccde8546",
      amount: AMOUNT,
      userEmail: "raka.demo@gmail.com",
      status: "OPEN",
    },
  });

  // 6. Transfer dari wallet yang sama sekali tak dikenal
  await prisma.unmatchedTransfer.create({
    data: {
      txHash: tx(),
      fromAddress: wallet(),
      toAddress: "0x1fb56441c55e3730f9f5c43d94a5ff21ecfafe01",
      tokenAddress: "0xafa702c0a2a3a0cf1bd09435db61c913ccde8546",
      amount: new Prisma.Decimal("0.075"),
      userEmail: null,
      status: "OPEN",
    },
  });

  // Recount stock from available slots.
  const available = await prisma.redemptionSlot.count({
    where: { voucherId: voucher.id, status: "AVAILABLE" },
  });
  await prisma.voucher.update({
    where: { id: voucher.id },
    data: { remainingStock: available },
  });

  console.log("Demo seeded: 6 redemptions (semua status) + 2 unmatched transfers (1 ambigu ber-kandidat, 1 wallet asing)");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
