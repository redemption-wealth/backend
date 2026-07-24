/** DEMO — riwayat 4 status untuk akun review + kartu manual-fulfill. TEST DB only. */
import "dotenv/config";
import { prisma } from "../src/db.js";
import { Prisma } from "@prisma/client";

const url = process.env.DATABASE_URL ?? "";
if (!/ulncvbzreqtrfbkfrjrh|localhost/.test(url)) throw new Error("SAFETY: test DB only");

const EMAIL = "wisnu.barata111@gmail.com";
const AMT = new Prisma.Decimal("0.1509659771120788");
const h = (s: string) =>
  "0x" + Buffer.from(s.padEnd(32, "x")).toString("hex");

async function main() {
  const voucher = await prisma.voucher.findFirst({
    where: { title: "PGR Tasikmalaya VIP (DEMO)" },
    select: { id: true, merchantId: true },
  });
  if (!voucher) throw new Error("Demo voucher missing — run seed-reliability-demo first");

  // Create dedicated slots (high indices to avoid clashing with the base seed).
  const slots = [];
  for (const slotIndex of [51, 52]) {
    const existing = await prisma.redemptionSlot.findFirst({
      where: { voucherId: voucher.id, slotIndex },
    });
    if (existing) {
      slots.push(existing);
      continue;
    }
    const slot = await prisma.redemptionSlot.create({
      data: { voucherId: voucher.id, slotIndex, status: "REDEEMED" },
    });
    await prisma.qrCode.createMany({
      data: [1, 2].map((qrNumber) => ({
        voucherId: voucher.id,
        slotId: slot.id,
        qrNumber,
        token: `demo-wisnu-${slotIndex}-${qrNumber}`,
        imageHash: `demo-wisnu-${slotIndex}-${qrNumber}`,
        value: `DEMO-WISNU-${slotIndex}-${qrNumber}`,
      })),
    });
    slots.push(slot);
  }

  const base = {
    voucherId: voucher.id,
    merchantId: voucher.merchantId,
    priceIdrAtRedeem: 300000,
    wealthPriceIdrAtRedeem: new Prisma.Decimal("2004425.1413"),
    appFeeAmount: new Prisma.Decimal("0.001"),
    gasFeeAmount: new Prisma.Decimal("0.00025"),
    walletAddress: "0x" + "ab".repeat(20),
    wealthAmount: AMT,
    userEmail: EMAIL,
  };

  await prisma.redemption.createMany({
    data: [
      { ...base, id: "demo-wisnu-confirmed", slotId: slots[0].id, txHash: h("wisnu-paid-ok"), idempotencyKey: "demo-w1", status: "CONFIRMED", confirmedAt: new Date(Date.now() - 2 * 3600e3), createdAt: new Date(Date.now() - 2.1 * 3600e3) },
      { ...base, id: "demo-wisnu-pending", slotId: slots[1].id, txHash: h("wisnu-pending-tx"), idempotencyKey: "demo-w2", status: "PENDING", createdAt: new Date(Date.now() - 8 * 60e3) },
      { ...base, id: "demo-wisnu-expired", slotId: null, txHash: null, idempotencyKey: "demo-w3", status: "EXPIRED", failedAt: new Date(Date.now() - 24 * 3600e3), createdAt: new Date(Date.now() - 25 * 3600e3) },
      { ...base, id: "demo-wisnu-refunded", slotId: null, txHash: h("wisnu-refunded-tx"), refundTxHash: h("wisnu-refund-proof"), refundedAt: new Date(Date.now() - 3 * 3600e3), idempotencyKey: "demo-w4", status: "REFUNDED", createdAt: new Date(Date.now() - 5 * 3600e3) },
    ],
    skipDuplicates: true,
  });

  await prisma.appUser.upsert({
    where: { privyId: "demo-privy-sari" },
    update: {},
    create: { privyId: "demo-privy-sari", email: "sari.demo@gmail.com", walletAddress: "0x" + "5a".repeat(20), referralCode: "demo-sari" },
  });
  await prisma.unmatchedTransfer.upsert({
    where: { txHash: h("sari-mystery-transfer") },
    update: {},
    create: { txHash: h("sari-mystery-transfer"), fromAddress: "0x" + "5a".repeat(20), toAddress: "0x1fb56441c55e3730f9f5c43d94a5ff21ecfafe01", tokenAddress: "0xafa702c0a2a3a0cf1bd09435db61c913ccde8546", amount: new Prisma.Decimal("0.3019319542241576"), userEmail: "sari.demo@gmail.com", status: "OPEN" },
  });

  console.log("Wisnu riwayat (4 status) + kartu sari (manual-fulfill) seeded");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
