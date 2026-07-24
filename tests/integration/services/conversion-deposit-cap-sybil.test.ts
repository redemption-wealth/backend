import { describe, it, expect, beforeEach } from "vitest";
import { testPrisma } from "../../setup.integration.js";
import {
  convertWp,
  DepositCapError,
  MonthlyBudgetError,
} from "@/services/wpConversion.js";

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

async function enableConversion(opts: { budgetWealth?: string } = {}) {
  // rate 1 → wpAmount == $WEALTH owed; huge per-user/global ceilings so ONLY the
  // control under test can bind (override budget where a test targets it).
  const budget = opts.budgetWealth ?? "1000000000";
  const common = {
    wpConversionEnabled: true,
    wpConversionRate: 1,
    wpConvertMinWp: 1,
    wpConvertMaxWpPerMonth: 1_000_000_000,
    wpConversionMonthlyBudgetWealth: budget,
  };
  await testPrisma.appSettings.upsert({
    where: { id: "singleton" },
    update: common,
    create: { id: "singleton", appFeeRate: 3, gasFeeAmount: 0, ...common },
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

describe("global monthly conversion budget holds under a cross-user race", () => {
  it("two different users converting at once cannot jointly exceed the budget", async () => {
    // Budget fits exactly ONE 5-$WEALTH conversion. Distinct emails so the
    // per-account deposit cap (ample here) never binds — only the GLOBAL budget.
    await enableConversion({ budgetWealth: "5" });
    const emailA = "race-a@test";
    const emailB = "race-b@test";
    const a = await makeAccount(emailA);
    const b = await makeAccount(emailB);
    await seedConfirmedRedemption(a.id, emailA, "1000");
    await seedConfirmedRedemption(b.id, emailB, "1000");
    await grantWp(a.id, 5);
    await grantWp(b.id, 5);

    const results = await Promise.allSettled([
      convertWp(
        { id: a.id, email: emailA, hasDeposited: true, fraudReviewStatus: "NONE" },
        5,
        "0x" + "a".repeat(40),
      ),
      convertWp(
        { id: b.id, email: emailB, hasDeposited: true, fraudReviewStatus: "NONE" },
        5,
        "0x" + "b".repeat(40),
      ),
    ]);

    const ok = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(ok.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      MonthlyBudgetError,
    );

    // Committed (PENDING/FULFILLED) $WEALTH must never exceed the 5 budget.
    const committed = await testPrisma.wpConversion.aggregate({
      _sum: { wealthAmount: true },
      where: { status: { in: ["PENDING", "FULFILLED"] } },
    });
    expect(Number(committed._sum.wealthAmount ?? 0)).toBeLessThanOrEqual(5);
  });
});
