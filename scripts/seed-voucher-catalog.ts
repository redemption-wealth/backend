/**
 * DEMO SEED — a realistic voucher catalog for back-office review / meetings.
 * Creates several merchants and vouchers, each with AVAILABLE slots + QR codes
 * so the catalog, stock counts, and QR monitor all show real content.
 *
 * Idempotent-ish: skips a voucher whose title already exists (safe to re-run).
 * SAFETY: refuses to run against anything that is not the DEV project / localhost.
 *
 * Usage:  npx tsx scripts/seed-voucher-catalog.ts     (from /backend)
 */
import "dotenv/config";
import { randomBytes } from "crypto";
import { prisma } from "../src/db.js";
import { Prisma } from "@prisma/client";

const url = process.env.DATABASE_URL ?? "";
if (!/ulncvbzreqtrfbkfrjrh|localhost|127\.0\.0\.1/.test(url)) {
  throw new Error("SAFETY: this seed only runs against the DEV project or localhost");
}

const hex = (n: number) => randomBytes(n).toString("hex");

type Item = {
  merchant: string;
  category: string;
  title: string;
  description: string;
  basePrice: number;
  stock: number;
};

const CATALOG: Item[] = [
  { merchant: "Kopi Kenangan", category: "Kuliner", title: "Kopi Kenangan Mantan — Rp 25.000", description: "Voucher 1 gelas Kopi Kenangan Mantan (regular).", basePrice: 25000, stock: 10 },
  { merchant: "Kopi Kenangan", category: "Kuliner", title: "Buy 1 Get 1 Latte", description: "Beli 1 gratis 1 untuk semua varian Latte.", basePrice: 33000, stock: 8 },
  { merchant: "Fore Coffee", category: "Kuliner", title: "Americano Gratis", description: "Tukar poin dengan 1 Americano ukuran regular.", basePrice: 27000, stock: 12 },
  { merchant: "Sportstation", category: "Retail", title: "Diskon Sepatu Rp 100.000", description: "Potongan Rp 100.000 min. belanja Rp 500.000.", basePrice: 100000, stock: 6 },
  { merchant: "Alfamart", category: "Retail", title: "Voucher Belanja Rp 50.000", description: "Voucher belanja di seluruh gerai Alfamart.", basePrice: 50000, stock: 15 },
  { merchant: "CGV Cinemas", category: "Hiburan", title: "Tiket Nonton Reguler (2D)", description: "1 tiket nonton reguler 2D, Senin–Kamis.", basePrice: 45000, stock: 9 },
  { merchant: "Chatime", category: "Kuliner", title: "Chatime Milk Tea — Rp 20.000", description: "Voucher 1 cup Chatime Classic Milk Tea (M).", basePrice: 20000, stock: 14 },
];

async function upsertMerchant(name: string, category: string) {
  const existing = await prisma.merchant.findFirst({ where: { name } });
  if (existing) return existing;
  return prisma.merchant.create({ data: { name, category } });
}

async function seedVoucher(item: Item) {
  const existing = await prisma.voucher.findFirst({ where: { title: item.title } });
  if (existing) {
    console.log(`  = skip (exists): ${item.title}`);
    return;
  }
  const merchant = await upsertMerchant(item.merchant, item.category);

  const voucher = await prisma.voucher.create({
    data: {
      merchantId: merchant.id,
      title: item.title,
      description: item.description,
      basePrice: new Prisma.Decimal(item.basePrice),
      totalStock: item.stock,
      remainingStock: item.stock,
      qrPerSlot: 1,
      format: "QR",
      assetSource: "WEALTH_GENERATED",
      assetInputType: "VALUE",
      appFeeSnapshot: new Prisma.Decimal("0.7"),
      gasFeeSnapshot: new Prisma.Decimal(500),
      startDate: new Date("2026-07-01"),
      expiryDate: new Date("2026-12-31"),
      isActive: true,
    },
  });

  // One AVAILABLE slot + 1 AVAILABLE QR per unit of stock.
  for (let slotIndex = 1; slotIndex <= item.stock; slotIndex++) {
    const slot = await prisma.redemptionSlot.create({
      data: { voucherId: voucher.id, slotIndex, status: "AVAILABLE" },
    });
    await prisma.qrCode.create({
      data: {
        voucherId: voucher.id,
        slotId: slot.id,
        qrNumber: 1,
        token: `cat-${hex(12)}`,
        imageHash: `cat-${hex(12)}`,
        value: `${item.merchant.slice(0, 3).toUpperCase()}-${slotIndex}-${hex(3).toUpperCase()}`,
        status: "AVAILABLE",
      },
    });
  }
  console.log(`  + ${item.title} (${item.merchant}) — stock ${item.stock}`);
}

async function main() {
  console.log("Seeding voucher catalog into DEV…");
  for (const item of CATALOG) await seedVoucher(item);
  const [m, v] = await Promise.all([prisma.merchant.count(), prisma.voucher.count()]);
  console.log(`\nDone. merchants=${m} vouchers=${v}`);
}

main()
  .catch((err) => {
    console.error("[seed-voucher-catalog] FAILED:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
