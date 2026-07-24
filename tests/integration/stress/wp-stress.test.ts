import { describe, it, expect, beforeEach } from "vitest";
import { testPrisma } from "../../setup.integration.js";
import { claimTask, claimMilestoneTier } from "@/services/quest.js";
import { redeemReward, addRewardAssets } from "@/services/reward.js";
import { adminAdjust } from "@/services/wp.js";

/**
 * Stress / concurrency verification for the revamp. Real DB, no mocks. Hammers the
 * new mint/spend/claim paths with Promise.all to shake out races: exactly-once
 * idempotency, no pool oversell, no overspend, and exact referral totals under load.
 */

let seq = 0;
async function makeUser(opts: { deposited?: boolean; referredById?: string; rateBps?: number } = {}) {
  seq += 1;
  const user = await testPrisma.appUser.create({
    data: {
      privyId: `stress-${seq}-${Date.now()}`,
      email: `stress${seq}@test.local`,
      referralCode: `STRESS${seq}${Date.now().toString(36).toUpperCase()}`.slice(0, 20),
      referredById: opts.referredById ?? null,
      ...(opts.rateBps !== undefined ? { referralRateBps: opts.rateBps } : {}),
    },
  });
  // Eligibility is LIVE — a "deposited" user must own a CONFIRMED redemption.
  if (opts.deposited) await seedConfirmedRedemption(user.id, user.email);
  return user;
}

async function balanceOf(appUserId: string): Promise<number> {
  const agg = await testPrisma.wpLedger.aggregate({
    _sum: { amount: true },
    where: { appUserId },
  });
  return agg._sum.amount ?? 0;
}

let redemptionSeq = 0;
async function seedConfirmedRedemption(appUserId: string, email: string) {
  redemptionSeq += 1;
  const tag = `stress-dep-${Date.now()}-${redemptionSeq}`;
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
  await testPrisma.wpRewardAsset.deleteMany();
  await testPrisma.wpRedemption.deleteMany();
  await testPrisma.wpLedger.deleteMany();
  await testPrisma.questCompletion.deleteMany();
  await testPrisma.redemption.deleteMany();
  await testPrisma.qrCode.deleteMany();
  await testPrisma.redemptionSlot.deleteMany();
  await testPrisma.voucher.deleteMany();
  await testPrisma.merchant.deleteMany();
  await testPrisma.wpReward.deleteMany();
  await testPrisma.quest.deleteMany();
  await testPrisma.appUser.deleteMany();
});

describe("stress: tier claim idempotency under concurrency", () => {
  it("claiming the SAME tier 15× concurrently credits exactly once", async () => {
    const user = await makeUser({ deposited: true });
    await seedConfirmedRedemption(user.id, user.email);
    const quest = await testPrisma.quest.create({
      data: {
        key: "stress-redeem-tier",
        title: "Redeem tiered",
        category: "REDEEM",
        rewardWp: 0,
        cadence: "ONCE",
        milestoneBaseWp: 20,
        milestoneLadder: "1,3,5",
      },
    });

    const results = await Promise.allSettled(
      Array.from({ length: 15 }, () => claimMilestoneTier(user.id, quest.key, 1)),
    );
    const claimed = results.filter(
      (r) => r.status === "fulfilled" && r.value.alreadyClaimed === false,
    );

    // Exactly one real credit; the rest are no-ops or rejected — never a double mint.
    expect(claimed.length).toBe(1);
    const completions = await testPrisma.questCompletion.count({
      where: { questId: quest.id, periodKey: "tier:1" },
    });
    expect(completions).toBe(1);
    // Deposited claimer: 20 base + 10% self-bonus = 22.
    expect(await balanceOf(user.id)).toBe(22);
  });
});

describe("stress: AUTO reward pool never oversells", () => {
  it("10 deposited users redeem a 3-asset pool concurrently → exactly 3 fulfilled", async () => {
    const reward = await testPrisma.wpReward.create({
      data: {
        title: "Stress voucher",
        category: "VOUCHER",
        wpCost: 100,
        fulfillmentType: "AUTO",
        isActive: true,
      },
    });
    await addRewardAssets(reward.id, "CODE", ["A1", "A2", "A3"]);

    const users = await Promise.all(
      Array.from({ length: 10 }, async () => {
        const u = await makeUser({ deposited: true });
        await adminAdjust(u.id, 500, "seed");
        return u;
      }),
    );

    const results = await Promise.allSettled(
      users.map((u) => redeemReward(u.id, reward.id)),
    );
    const fulfilled = results.filter((r) => r.status === "fulfilled");

    // Exactly 3 succeed (pool size); no asset assigned twice; no negative balances.
    expect(fulfilled.length).toBe(3);
    const assigned = await testPrisma.wpRewardAsset.count({
      where: { rewardId: reward.id, status: "ASSIGNED" },
    });
    expect(assigned).toBe(3);
    for (const u of users) expect(await balanceOf(u.id)).toBeGreaterThanOrEqual(0);
  });
});

describe("stress: WP spend never goes negative", () => {
  it("two concurrent redeems that each cost the full balance → exactly one succeeds", async () => {
    const reward = await testPrisma.wpReward.create({
      data: {
        title: "Costly",
        category: "MERCH",
        wpCost: 100,
        stock: 5,
        fulfillmentType: "MANUAL",
        isActive: true,
      },
    });
    const u = await makeUser({ deposited: true });
    await adminAdjust(u.id, 100, "seed"); // exactly one redeem's worth

    const results = await Promise.allSettled([
      redeemReward(u.id, reward.id, {
        recipientName: "A",
        recipientPhone: "1",
        shippingAddress: "X",
      }),
      redeemReward(u.id, reward.id, {
        recipientName: "A",
        recipientPhone: "1",
        shippingAddress: "X",
      }),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");

    expect(ok.length).toBe(1);
    expect(await balanceOf(u.id)).toBe(0); // never negative, never double-spent
  });
});

describe("stress: referral totals under load", () => {
  it("30 referees of one KOL claim concurrently → 30 exact referral rows", async () => {
    const kol = await makeUser({ rateBps: 1000 });
    const quest = await testPrisma.quest.create({
      data: {
        key: "stress-social",
        title: "Follow",
        description: "x",
        category: "SOCIAL",
        rewardWp: 100,
        cadence: "ONCE",
      },
    });
    const referees = await Promise.all(
      Array.from({ length: 30 }, () =>
        makeUser({ deposited: true, referredById: kol.id }),
      ),
    );

    await Promise.all(referees.map((r) => claimTask(r.id, quest.key)));

    const rows = await testPrisma.wpLedger.count({
      where: { appUserId: kol.id, refType: "referral_quest" },
    });
    expect(rows).toBe(30);
    expect(await balanceOf(kol.id)).toBe(300); // 30 × floor(100 × 0.10)
  });
});
