import { describe, it, expect, beforeEach } from "vitest";
import { testPrisma } from "../../setup.integration.js";
import { syncAppUser } from "@/services/appUser.js";

/**
 * Security (Finding 2): the deposit gate (hasDeposited) is tied to the ACCOUNT
 * (appUserId), not the shared Privy email. Two accounts with the same email must
 * NOT both qualify from a single deposit — only the account that actually made a
 * CONFIRMED redemption qualifies. Real DB, no mocks.
 */

let seq = 0;
async function makeAccount(email: string) {
  seq += 1;
  return testPrisma.appUser.create({
    data: {
      privyId: `sybil-privy-${seq}`,
      email,
      referralCode: `SYBIL${seq}${Date.now().toString(36).toUpperCase()}`.slice(0, 20),
    },
  });
}

async function seedConfirmedRedemptionFor(appUserId: string, email: string) {
  const tag = `sybil-dep-${Date.now()}-${appUserId}`;
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
      wealthAmount: "1000",
      priceIdrAtRedeem: 1,
      wealthPriceIdrAtRedeem: "1",
      appFeeAmount: "0",
      gasFeeAmount: "0",
      idempotencyKey: `${tag}-idm`,
      status: "CONFIRMED",
    },
  });
}

beforeEach(async () => {
  await testPrisma.redemption.deleteMany();
  await testPrisma.qrCode.deleteMany();
  await testPrisma.redemptionSlot.deleteMany();
  await testPrisma.voucher.deleteMany();
  await testPrisma.merchant.deleteMany();
  await testPrisma.appUser.deleteMany();
});

describe("deposit gate is per-account, not per email (anti-sybil)", () => {
  it("only the account that deposited qualifies, even when a sybil shares the email", async () => {
    const email = "shared@sybil.test";
    const depositor = await makeAccount(email);
    const sybil = await makeAccount(email); // same email, different Privy account
    // The real deposit is tied to the depositor's account.
    await seedConfirmedRedemptionFor(depositor.id, email);

    const depositorSynced = await syncAppUser({
      privyUserId: depositor.privyId,
      userEmail: email,
    });
    const sybilSynced = await syncAppUser({
      privyUserId: sybil.privyId,
      userEmail: email,
    });

    expect(depositorSynced.hasDeposited).toBe(true);
    // The sybil sharing the email does NOT inherit qualification.
    expect(sybilSynced.hasDeposited).toBe(false);
  });

  it("a brand-new account is never qualified on first sync", async () => {
    const created = await syncAppUser({
      privyUserId: "fresh-privy-1",
      userEmail: "fresh@sybil.test",
    });
    expect(created.hasDeposited).toBe(false);
  });
});
