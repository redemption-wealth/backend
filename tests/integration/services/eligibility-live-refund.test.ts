import { describe, it, expect, beforeEach, vi } from "vitest";
import { testPrisma } from "../../setup.integration.js";

/**
 * Eligibility & milestone progress are LIVE-derived from this account's CONFIRMED
 * on-chain redemptions (by appUserId) — not a set-once `hasDeposited` flag. So a
 * REFUND (CONFIRMED → REFUNDED) must immediately close the redeem/convert gate,
 * turn off the +10% self-bonus, and drop REDEEM + a referrer's INVITE progress.
 * Real DB, no data mocks (only the CMC price service is stubbed).
 */
vi.mock("@/services/price.js", () => ({
  getWealthPrice: vi.fn(async () => ({ priceIdr: 850, cached: false })),
}));

let seq = 0;
async function makeUser(opts: { referredById?: string } = {}) {
  seq += 1;
  return testPrisma.appUser.create({
    data: {
      privyId: `elig-${seq}-${Date.now().toString(36)}`,
      email: `elig-${seq}@test.local`,
      referralCode: `ELIG${seq}${Date.now().toString(36).toUpperCase()}`.slice(0, 20),
      referredById: opts.referredById ?? null,
    },
  });
}

// Create a redemption row for this account and return it (default CONFIRMED).
async function seedRedemption(appUserId: string, status = "CONFIRMED") {
  const tag = `elig-red-${Date.now()}-${appUserId}-${seq++}`;
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
  return testPrisma.redemption.create({
    data: {
      userEmail: `red-${tag}@test.local`,
      appUserId,
      voucherId: voucher.id,
      merchantId: merchant.id,
      slotId: slot.id,
      wealthAmount: "10",
      priceIdrAtRedeem: 1,
      wealthPriceIdrAtRedeem: "1",
      appFeeAmount: "0",
      gasFeeAmount: "0",
      idempotencyKey: `${tag}-idm`,
      status,
    },
  });
}

beforeEach(async () => {
  // Clear every table that RESTRICT-references appUser (incl. rows a prior test
  // file may have left — CI runs files in a different order than local) so the
  // appUser wipe below can't hit a foreign-key violation.
  await testPrisma.wpConversion.deleteMany();
  await testPrisma.wpLedger.deleteMany();
  await testPrisma.wpRedemption.deleteMany();
  await testPrisma.wpReward.deleteMany();
  await testPrisma.questCompletion.deleteMany();
  await testPrisma.quest.deleteMany();
  await testPrisma.redemption.deleteMany();
  await testPrisma.redemptionSlot.deleteMany();
  await testPrisma.voucher.deleteMany();
  await testPrisma.merchant.deleteMany();
  await testPrisma.appUser.deleteMany();
});

describe("eligibility is live-derived and reverses on refund", () => {
  it("hasRedeemed flips true on a CONFIRMED redemption and false again on refund", async () => {
    const { hasRedeemed, confirmedRedemptionCount } = await import(
      "@/services/appUser.js"
    );
    const u = await makeUser();
    expect(await hasRedeemed(u.id)).toBe(false);

    const red = await seedRedemption(u.id, "CONFIRMED");
    expect(await hasRedeemed(u.id)).toBe(true);
    expect(await confirmedRedemptionCount(u.id)).toBe(1);

    await testPrisma.redemption.update({
      where: { id: red.id },
      data: { status: "REFUNDED" },
    });
    expect(await hasRedeemed(u.id)).toBe(false);
    expect(await confirmedRedemptionCount(u.id)).toBe(0);
  });

  it("the WP-store redeem gate closes again after the redemption is refunded", async () => {
    const { redeemReward, NotQualifiedError } = await import(
      "@/services/reward.js"
    );
    const { adminAdjust } = await import("@/services/wp.js");

    const u = await makeUser();
    await adminAdjust(u.id, 1000, "seed WP");
    const reward = await testPrisma.wpReward.create({
      data: { title: "Voucher X", category: "VOUCHER", wpCost: 100, stock: null },
    });
    const red = await seedRedemption(u.id, "CONFIRMED");

    // Eligible now → redeem succeeds.
    const first = await redeemReward(u.id, reward.id);
    expect(first.status).toBe("PENDING");

    // Refund the only qualifying redemption → gate must close again.
    await testPrisma.redemption.update({
      where: { id: red.id },
      data: { status: "REFUNDED" },
    });
    await expect(redeemReward(u.id, reward.id)).rejects.toBeInstanceOf(
      NotQualifiedError,
    );
  });

  it("a referrer's INVITE progress drops when the referee's redemption is refunded", async () => {
    const { listQuestsForUser } = await import("@/services/quest.js");
    const referrer = await makeUser();
    const referee = await makeUser({ referredById: referrer.id });
    await testPrisma.quest.create({
      data: {
        key: "invite-tiered",
        title: "Invite friends",
        category: "INVITE",
        rewardWp: 0,
        cadence: "ONCE",
        targetCount: 1,
        milestoneBaseWp: 10,
        milestoneLadder: "1,3,5",
      },
    });

    const red = await seedRedemption(referee.id, "CONFIRMED");
    const before = (await listQuestsForUser(referrer.id)).quests.find(
      (q) => q.key === "invite-tiered",
    ) as { progress?: number } | undefined;
    expect(before?.progress).toBe(1);

    await testPrisma.redemption.update({
      where: { id: red.id },
      data: { status: "REFUNDED" },
    });
    const after = (await listQuestsForUser(referrer.id)).quests.find(
      (q) => q.key === "invite-tiered",
    ) as { progress?: number } | undefined;
    expect(after?.progress).toBe(0);
  });
});
