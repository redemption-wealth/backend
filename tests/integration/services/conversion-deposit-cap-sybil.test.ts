import { describe, it, expect, beforeEach } from "vitest";
import { testPrisma } from "../../setup.integration.js";
import { convertWp, DepositCapError } from "@/services/wpConversion.js";

/**
 * Security (anti-sybil): the WP->$WEALTH conversion deposit cap must be keyed by
 * the ACCOUNT (appUserId) — exactly like the hasDeposited gate
 * (services/appUser.ts:userHasConfirmedRedemption) — NOT by the shared, non-unique
 * Privy email. One email can back many AppUser accounts; an email-keyed ceiling
 * lets each sybil account convert against the COMBINED deposits of every account
 * sharing the email, extracting far more $WEALTH than was ever deposited. Real DB,
 * no mocks (only the anti-sybil ceiling is under test).
 */

let seq = 0;
async function makeAccount(email: string) {
  seq += 1;
  return testPrisma.appUser.create({
    data: {
      privyId: `conv-sybil-${seq}-${Date.now().toString(36)}`,
      email,
      referralCode: `CS${seq}${Date.now().toString(36).toUpperCase()}`.slice(0, 20),
      hasDeposited: true,
    },
  });
}

async function seedConfirmedRedemption(
  appUserId: string,
  email: string,
  wealth: string,
) {
  const tag = `conv-dep-${Date.now()}-${appUserId}`;
  const merchant = await testPrisma.merchant.create({ data: { name: tag } });
  const voucher = await testPrisma.voucher.create({
    data: {
      merchantId: merchant.id,
      title: `${tag}-v`,
      basePrice: 1,
      totalStock: 1,
      remainingStock: 1,
      appFeeSnapshot: 0,
      gasFeeSnapshot: 0,
      startDate: new Date("2020-01-01"),
      expiryDate: new Date("2030-01-01"),
    },
  });
  const slot = await testPrisma.redemptionSlot.create({
    data: { voucherId: voucher.id, slotIndex: 0, status: "AVAILABLE" },
  });
  await testPrisma.redemption.create({
    data: {
      userEmail: email,
      appUserId,
      voucherId: voucher.id,
      merchantId: merchant.id,
      slotId: slot.id,
      wealthAmount: wealth,
      priceIdrAtRedeem: 1,
      wealthPriceIdrAtRedeem: "1",
      appFeeAmount: "0",
      gasFeeAmount: "0",
      idempotencyKey: `${tag}-idm`,
      status: "CONFIRMED",
    },
  });
}

async function grantWp(appUserId: string, amount: number) {
  await testPrisma.wpLedger.create({
    data: { appUserId, amount, type: "ADMIN_ADJUST", refType: "admin", note: "seed" },
  });
}

async function enableConversion() {
  // rate 1 → wpAmount == $WEALTH owed; huge per-user/global ceilings so ONLY the
  // per-account deposit cap can bind in these tests.
  await testPrisma.appSettings.upsert({
    where: { id: "singleton" },
    update: {
      wpConversionEnabled: true,
      wpConversionRate: 1,
      wpConvertMinWp: 1,
      wpConvertMaxWpPerMonth: 1_000_000_000,
      wpConversionMonthlyBudgetWealth: "1000000000",
    },
    create: {
      id: "singleton",
      appFeeRate: 3,
      gasFeeAmount: 0,
      wpConversionEnabled: true,
      wpConversionRate: 1,
      wpConvertMinWp: 1,
      wpConvertMaxWpPerMonth: 1_000_000_000,
      wpConversionMonthlyBudgetWealth: "1000000000",
    },
  });
}

beforeEach(async () => {
  await testPrisma.wpConversion.deleteMany();
  await testPrisma.wpLedger.deleteMany();
  await testPrisma.redemption.deleteMany();
  await testPrisma.redemptionSlot.deleteMany();
  await testPrisma.voucher.deleteMany();
  await testPrisma.merchant.deleteMany();
  await testPrisma.appUser.deleteMany();
  await testPrisma.appSettings.deleteMany();
});

describe("conversion deposit cap is per-account, not per-email (anti-sybil)", () => {
  it("a sybil sharing the email cannot convert against another account's deposit", async () => {
    await enableConversion();
    const email = "conv-shared@sybil.test";
    const a = await makeAccount(email); // deposits 100
    const b = await makeAccount(email); // sybil, also deposits 100
    await seedConfirmedRedemption(a.id, email, "100");
    await seedConfirmedRedemption(b.id, email, "100");

    // B has ample WP and tries to convert 150 $WEALTH — more than ITS OWN 100
    // deposit, but under the shared-email total of 200. Its cap is its own 100.
    await grantWp(b.id, 150);
    const bUser = {
      id: b.id,
      email,
      hasDeposited: true,
      fraudReviewStatus: "NONE" as const,
    };

    await expect(
      convertWp(bUser, 150, "0x" + "b".repeat(40)),
    ).rejects.toBeInstanceOf(DepositCapError);

    // Nothing was burned — the guard fired before spendWithTx.
    const burned = await testPrisma.wpLedger.aggregate({
      _sum: { amount: true },
      where: { appUserId: b.id, type: "CONVERT_SPEND" },
    });
    expect(burned._sum.amount ?? 0).toBe(0);
  });

  it("a user may convert up to its own confirmed deposit", async () => {
    await enableConversion();
    const email = "conv-solo@sybil.test";
    const a = await makeAccount(email);
    await seedConfirmedRedemption(a.id, email, "100");
    await grantWp(a.id, 100);

    const res = await convertWp(
      { id: a.id, email, hasDeposited: true, fraudReviewStatus: "NONE" },
      100,
      "0x" + "a".repeat(40),
    );
    expect(res.status).toBe("PENDING");
    expect(res.wpBurned).toBe(100);
  });
});
