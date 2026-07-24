/**
 * One-off recovery: recreate a redemption whose on-chain transfer SUCCEEDED but
 * whose PENDING row was deleted by the stale sweep because the app never
 * submitted the txHash (case: rakasyaefudin9423@gmail.com, 2026-07-16).
 *
 * On-chain facts (Ethereum mainnet, verified via eth_getTransactionReceipt):
 *   tx     0x0b5fc663dace323b5e63baf8792d8eb56db03379e036362714066ba407cbad47
 *   status success, block 25542302
 *   token  0xafa702c0a2a3a0cf1bd09435db61c913ccde8546 ($WEALTH)
 *   from   0x404392cfcc5f2ced743066b64c28cc436c58bf34 (user smart wallet)
 *   to     0x1fb56441c55e3730f9f5c43d94a5ff21ecfafe01 (treasury)
 *   amount 150965977112078800 wei = 0.1509659771120788 $WEALTH
 *
 * Deliberately does NOT call initiateRedemption: that path fetches a live CMC
 * price (can fail, and today's price is not what the user paid). Instead the
 * slot reservation + row creation are replicated inline with money fields
 * derived from the on-chain amount, then confirmRedemption() runs the exact
 * same QR-assignment + stock path the webhook uses.
 *
 * Idempotent: guarded by the unique txHash — safe to re-run.
 *
 * DRY RUN (default):  npx tsx scripts/recover-redemption.ts
 * APPLY:              EXECUTE=true npx tsx scripts/recover-redemption.ts
 * Against prod, override the connection first:
 *   DATABASE_URL="<prod>" DIRECT_URL="<prod>" EXECUTE=true npx tsx scripts/recover-redemption.ts
 */
import "dotenv/config";
import { prisma } from "../src/db.js";
import { Prisma } from "@prisma/client";
import { confirmRedemption } from "../src/services/redemption.js";

const USER_EMAIL = "rakasyaefudin9423@gmail.com";
// Prod voucher id verified via the live API (title "PGR Tasikmalaya VIP",
// basePrice 300000, qrPerSlot 2, BARCODE/MERCHANT_UPLOADED, fee 0.7% + 500).
// REHEARSAL_VOUCHER_ID overrides it during the local rehearsal run only.
const VOUCHER_ID =
  process.env.REHEARSAL_VOUCHER_ID ?? "7bf8b227-bb15-4046-8f33-cb1bbf7006d3";
const TX_HASH =
  "0x0b5fc663dace323b5e63baf8792d8eb56db03379e036362714066ba407cbad47";
// Exact on-chain transfer amount (150965977112078800 wei @ 18 decimals)
const WEALTH_AMOUNT = new Prisma.Decimal("0.1509659771120788");
const IDEMPOTENCY_KEY = `manual-recovery-${TX_HASH}`;
const EXECUTE = process.env.EXECUTE === "true";

async function main() {
  console.log(`Mode: ${EXECUTE ? "EXECUTE" : "DRY RUN"}`);

  // 0. Idempotency: bail out if this tx is already recorded.
  const existingTx = await prisma.redemption.findUnique({
    where: { txHash: TX_HASH },
    include: { qrCodes: { select: { id: true, status: true } } },
  });
  if (existingTx) {
    console.log(
      `Already recovered: redemption ${existingTx.id} status=${existingTx.status} qrCodes=${existingTx.qrCodes.length}`,
    );
    return;
  }

  // 1. Locate the voucher + fee snapshots.
  const voucher = await prisma.voucher.findUnique({
    where: { id: VOUCHER_ID },
    select: {
      id: true,
      title: true,
      merchantId: true,
      basePrice: true,
      qrPerSlot: true,
      remainingStock: true,
      totalStock: true,
      isActive: true,
      format: true,
      assetSource: true,
      assetInputType: true,
      appFeeSnapshot: true,
      gasFeeSnapshot: true,
    },
  });
  if (!voucher) throw new Error(`Voucher ${VOUCHER_ID} not found`);
  if (!voucher.title.includes("PGR Tasikmalaya VIP")) {
    throw new Error(`Voucher ${VOUCHER_ID} title mismatch: "${voucher.title}"`);
  }
  console.log(
    `Voucher: ${voucher.title} (${voucher.id}) basePrice=${voucher.basePrice} stock=${voucher.remainingStock}/${voucher.totalStock} qrPerSlot=${voucher.qrPerSlot} ${voucher.format}/${voucher.assetSource}`,
  );

  // 2. Money fields — derived from the voucher's own fee snapshots and the
  //    on-chain amount, so the record reflects what the user ACTUALLY paid.
  const basePrice = new Prisma.Decimal(voucher.basePrice);
  const appFee = basePrice.mul(voucher.appFeeSnapshot).div(100);
  const gasFee = new Prisma.Decimal(voucher.gasFeeSnapshot);
  const totalIdr = basePrice.add(appFee).add(gasFee);
  // Implied WEALTH/IDR price at redeem time: total paid / tokens transferred.
  const wealthPriceIdr = totalIdr.div(WEALTH_AMOUNT);
  const appFeeAmount = appFee.div(wealthPriceIdr);
  const gasFeeAmount = gasFee.div(wealthPriceIdr);
  console.log(
    `Pricing: totalIdr=${totalIdr} (base=${basePrice} appFee=${appFee} gasFee=${gasFee}) impliedPrice=${wealthPriceIdr.toFixed(2)} IDR/WEALTH`,
  );

  // 3. Check an AVAILABLE slot exists with the expected QR records.
  const availableSlot = await prisma.redemptionSlot.findFirst({
    where: { voucherId: voucher.id, status: "AVAILABLE" },
    include: { qrCodes: { orderBy: { qrNumber: "asc" } } },
  });
  if (!availableSlot || availableSlot.qrCodes.length === 0) {
    throw new Error("No available slot with QR records");
  }
  if (availableSlot.qrCodes.length !== voucher.qrPerSlot) {
    throw new Error(
      `Slot ${availableSlot.id} has ${availableSlot.qrCodes.length} QR records, expected ${voucher.qrPerSlot}`,
    );
  }
  // Merchant-uploaded VALUE vouchers must have their ticket codes pre-stored
  // on the slot — confirmRedemption renders these into barcode images.
  if (
    voucher.assetSource === "MERCHANT_UPLOADED" &&
    voucher.assetInputType === "VALUE" &&
    availableSlot.qrCodes.some((qr) => !qr.value)
  ) {
    throw new Error(`Slot ${availableSlot.id} has QR records without values`);
  }
  console.log(
    `Slot ready: ${availableSlot.id} (index ${availableSlot.slotIndex}, ${availableSlot.qrCodes.length} QR records)`,
  );

  if (!EXECUTE) {
    console.log("\nDRY RUN — nothing written. Re-run with EXECUTE=true to apply.");
    return;
  }

  // 4. Create the PENDING redemption + reserve the slot atomically
  //    (mirrors initiateRedemption, minus the live CMC price fetch).
  const redemption = await prisma.$transaction(async (tx) => {
    const claimed = await tx.redemptionSlot.updateMany({
      where: { id: availableSlot.id, status: "AVAILABLE" },
      data: { status: "REDEEMED" },
    });
    if (claimed.count === 0) {
      throw new Error("Slot was claimed concurrently — re-run the script");
    }
    return tx.redemption.create({
      data: {
        userEmail: USER_EMAIL,
        voucherId: voucher.id,
        merchantId: voucher.merchantId,
        slotId: availableSlot.id,
        wealthAmount: WEALTH_AMOUNT,
        priceIdrAtRedeem: Math.round(Number(voucher.basePrice)),
        wealthPriceIdrAtRedeem: wealthPriceIdr,
        appFeeAmount,
        gasFeeAmount,
        txHash: TX_HASH,
        idempotencyKey: IDEMPOTENCY_KEY,
        status: "PENDING",
      },
    });
  });
  console.log(`Redemption created: ${redemption.id} (PENDING, slot reserved)`);

  // 5. Confirm — same path as the webhook: CONFIRMED + QR assignment + stock.
  const confirmed = await confirmRedemption(TX_HASH);
  console.log(`Status: ${confirmed.status}, confirmedAt: ${confirmed.confirmedAt}`);

  // 6. Verify the outcome.
  const qrCodes = await prisma.qrCode.findMany({
    where: { redemptionId: redemption.id },
    select: { id: true, status: true, imageUrl: true },
  });
  console.log(`QR codes assigned: ${qrCodes.length}/${voucher.qrPerSlot}`);
  for (const qr of qrCodes) {
    console.log(`  - ${qr.id} ${qr.status} imageUrl=${qr.imageUrl ? "set" : "MISSING (lazy-heal on first open)"}`);
  }
  const after = await prisma.voucher.findUniqueOrThrow({
    where: { id: voucher.id },
    select: { remainingStock: true },
  });
  console.log(`Stock: ${voucher.remainingStock} -> ${after.remainingStock}`);

  if (confirmed.status === "CONFIRMED" && qrCodes.length === voucher.qrPerSlot) {
    console.log(
      "\nSUCCESS — user will see the voucher in Voucher Saya + Riwayat Transaksi.",
    );
  } else {
    console.log(
      "\nPARTIAL — confirmation stands but QR assignment deferred; it self-heals when the user opens the redemption detail. Re-run this script to re-check.",
    );
  }
}

main()
  .catch((err) => {
    console.error("RECOVERY FAILED:", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
