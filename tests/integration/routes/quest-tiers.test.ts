import { describe, test, expect, beforeEach } from "vitest";
import {
  testPrisma,
  mockVerifyAuthToken,
  mockGetUser,
} from "../../setup.integration.js";
import { authGet, jsonPost } from "../../helpers/request.js";
import { createTestUserToken } from "../../helpers/auth.js";
import { claimMilestoneTier, claimAllMilestoneTiers } from "@/services/quest.js";

// ────────────────────────────────────────────────────────────────────────────
// Phase 3 — tiered milestone quests, REDEEM-by-email progress, and the closed
// unearned-mint exploit. Exercised through the real Hono app (app.request) with
// real Prisma against local Postgres. Privy is the only stub. NO data mocks.
// ────────────────────────────────────────────────────────────────────────────

function mockPrivyAs(privyUserId: string, email: string) {
  mockVerifyAuthToken.mockResolvedValue({ userId: privyUserId });
  mockGetUser.mockResolvedValue({ email: { address: email } });
}

let userSeq = 0;
function makeUser() {
  userSeq += 1;
  const uid = `${Date.now()}-${userSeq}`;
  return {
    email: `qtier-${uid}@test.com`,
    privyUserId: `qtier-privy-${uid}`,
    token: createTestUserToken(),
  };
}

/** Provision the AppUser (first GET /api/wp/balance) and return the DB row. */
async function provision(u: { privyUserId: string; email: string; token: string }) {
  mockPrivyAs(u.privyUserId, u.email);
  const res = await authGet("/api/wp/balance", u.token);
  expect(res.status).toBe(200);
  const row = (await testPrisma.appUser.findUnique({
    where: { privyId: u.privyUserId },
  }))!;
  // Qualification is per-account (appUserId). Link deposits seeded by email
  // (before the account existed) to the account and flip the gate.
  await testPrisma.redemption.updateMany({
    where: { userEmail: u.email, appUserId: null },
    data: { appUserId: row.id },
  });
  const confirmed = await testPrisma.redemption.count({
    where: { appUserId: row.id, status: "CONFIRMED" },
  });
  if (confirmed > 0 && !row.hasDeposited) {
    await testPrisma.appUser.update({
      where: { id: row.id },
      data: { hasDeposited: true, qualifiedAt: new Date() },
    });
    row.hasDeposited = true;
  }
  return row;
}

async function balanceOf(appUserId: string): Promise<number> {
  const agg = await testPrisma.wpLedger.aggregate({
    _sum: { amount: true },
    where: { appUserId },
  });
  return agg._sum.amount ?? 0;
}

let depSeq = 0;
/** Create one CONFIRMED on-chain redemption, optionally tied to an account. */
async function seedConfirmedRedemption(email: string, appUserId?: string) {
  depSeq += 1;
  const tag = `qtier-dep-${Date.now()}-${depSeq}`;
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
      appUserId: appUserId ?? null,
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

let refSeq = 0;
/** Create a qualified referral pointing at `referrerId`. "Qualified" is now LIVE:
 *  the referee must own a CONFIRMED on-chain redemption, not just a flag. */
async function seedQualifiedReferral(referrerId: string) {
  refSeq += 1;
  const uid = `${Date.now()}-${refSeq}`;
  const email = `qtier-ref-${uid}@test.com`;
  const referee = await testPrisma.appUser.create({
    data: {
      privyId: `qtier-ref-privy-${uid}`,
      email,
      referralCode: `QTREF${refSeq}${Date.now().toString(36).toUpperCase()}`.slice(0, 20),
      referredById: referrerId,
    },
  });
  await seedConfirmedRedemption(email, referee.id);
}

async function makeInviteTier(overrides?: {
  base?: number;
  ladder?: string | null;
  key?: string;
}) {
  return testPrisma.quest.create({
    data: {
      key: overrides?.key ?? `invite-tier-${Date.now()}-${userSeq}`,
      title: "Undang teman (tiered)",
      category: "INVITE",
      rewardWp: 0,
      cadence: "ONCE",
      targetCount: 1,
      milestoneBaseWp: overrides?.base ?? 10,
      milestoneLadder: overrides?.ladder ?? "1,3,5,10",
    },
  });
}

async function questsList(u: { token: string }) {
  const res = await authGet("/api/quests", u.token);
  expect(res.status).toBe(200);
  const body = await res.json();
  return body.quests as any[];
}

beforeEach(async () => {
  await testPrisma.wpConversion.deleteMany();
  await testPrisma.wpRedemption.deleteMany();
  await testPrisma.questCompletion.deleteMany();
  await testPrisma.wpLedger.deleteMany();
  await testPrisma.checkinStreak.deleteMany();
  await testPrisma.wpReward.deleteMany();
  await testPrisma.quest.deleteMany();
  await testPrisma.appUser.deleteMany();
});

// ─── REQ 1: REDEEM progress = count of CONFIRMED on-chain redemptions by email ──
describe("REDEEM milestone progress (on-chain, by email)", () => {
  test("progress equals the number of CONFIRMED redemptions for the user's email", async () => {
    await testPrisma.quest.create({
      data: {
        key: "redeem-tier",
        title: "Tukar reward",
        category: "REDEEM",
        rewardWp: 0,
        cadence: "ONCE",
        targetCount: 1,
        milestoneBaseWp: 20,
        milestoneLadder: "1,3,5",
      },
    });
    const u = makeUser();
    const appUser = await provision(u);
    for (let i = 0; i < 4; i++) await seedConfirmedRedemption(u.email, appUser.id);

    const quests = await questsList(u);
    const redeem = quests.find((q) => q.key === "redeem-tier");
    expect(redeem.progress).toBe(4);
    // A PENDING/other-status redemption must NOT count.
    expect(redeem.category).toBe("REDEEM");
  });
});

// ─── REQ 2 + 3: tiered claim path ───────────────────────────────────────────
describe("tiered milestone claim (INVITE)", () => {
  test("claims a tier, is idempotent, rejects a locked tier, updates balance", async () => {
    await makeInviteTier({ base: 10, ladder: "1,3,5,10", key: "invite-tier" });
    const u = makeUser();
    const appUser = await provision(u); // not deposited → no self-bonus
    for (let i = 0; i < 5; i++) await seedQualifiedReferral(appUser.id); // progress 5

    // claim tier 3 → 30 WP (3 * 10), no self-bonus
    mockPrivyAs(u.privyUserId, u.email);
    const c3 = await jsonPost("/api/quests/invite-tier/claim", { tier: 3 }, u.token);
    expect(c3.status).toBe(200);
    const b3 = await c3.json();
    expect(b3.alreadyClaimed).toBe(false);
    expect(b3.tier).toBe(3);
    expect(b3.reward).toBe(30);
    expect(b3.referralBonus).toBe(0);
    expect(b3.balance).toBe(30);

    // a tier:3 completion row exists
    const comp = await testPrisma.questCompletion.findFirst({
      where: { appUserId: appUser.id, periodKey: "tier:3" },
    });
    expect(comp).not.toBeNull();

    // re-claim tier 3 → alreadyClaimed, no double credit
    mockPrivyAs(u.privyUserId, u.email);
    const again = await jsonPost("/api/quests/invite-tier/claim", { tier: 3 }, u.token);
    expect(again.status).toBe(200);
    expect((await again.json()).alreadyClaimed).toBe(true);
    expect(await balanceOf(appUser.id)).toBe(30);

    // claim locked tier 10 (progress 5 < 10) → 409, still no extra credit
    mockPrivyAs(u.privyUserId, u.email);
    const locked = await jsonPost("/api/quests/invite-tier/claim", { tier: 10 }, u.token);
    expect(locked.status).toBe(409);
    expect(await balanceOf(appUser.id)).toBe(30);

    // claim a real unclaimed tier 5 → +50 WP
    mockPrivyAs(u.privyUserId, u.email);
    const c5 = await jsonPost("/api/quests/invite-tier/claim", { tier: 5 }, u.token);
    expect(c5.status).toBe(200);
    expect((await c5.json()).reward).toBe(50);
    expect(await balanceOf(appUser.id)).toBe(80);
  });

  test("tier not on the ladder → 409 (locked)", async () => {
    await makeInviteTier({ base: 10, ladder: "1,3,5,10", key: "invite-tier-2" });
    const u = makeUser();
    const appUser = await provision(u);
    for (let i = 0; i < 10; i++) await seedQualifiedReferral(appUser.id);
    mockPrivyAs(u.privyUserId, u.email);
    const res = await jsonPost("/api/quests/invite-tier-2/claim", { tier: 4 }, u.token);
    expect(res.status).toBe(409); // 4 is not a rung
  });

  test("deposited claimer earns the +10% self-bonus (referral hook fires on tiers)", async () => {
    await makeInviteTier({ base: 100, ladder: "1,3,5", key: "invite-tier-3" });
    const u = makeUser();
    await seedConfirmedRedemption(u.email); // flips hasDeposited before provision
    const appUser = await provision(u);
    expect(appUser.hasDeposited).toBe(true);
    for (let i = 0; i < 3; i++) await seedQualifiedReferral(appUser.id);

    mockPrivyAs(u.privyUserId, u.email);
    const res = await jsonPost("/api/quests/invite-tier-3/claim", { tier: 3 }, u.token);
    const body = await res.json();
    expect(body.base).toBe(300); // 3 * 100
    expect(body.referralBonus).toBe(30); // floor(300 * 0.1)
    expect(body.reward).toBe(330);
    expect(body.balance).toBe(330);
  });

  test("invalid tier body → 400", async () => {
    await makeInviteTier({ key: "invite-tier-bad" });
    const u = makeUser();
    await provision(u);
    mockPrivyAs(u.privyUserId, u.email);
    const res = await jsonPost("/api/quests/invite-tier-bad/claim", { tier: 0 }, u.token);
    expect(res.status).toBe(400);
  });
});

// ─── REQ 4: GET /api/quests exposes tier state ──────────────────────────────
describe("GET /api/quests tier state", () => {
  test("returns ladder, progress, claimedTiers, claimableTiers for tiered quests", async () => {
    await makeInviteTier({ base: 10, ladder: "1,3,5,10", key: "invite-state" });
    const u = makeUser();
    const appUser = await provision(u);
    for (let i = 0; i < 5; i++) await seedQualifiedReferral(appUser.id); // progress 5

    // claim tier 3 first so it shows as claimed
    mockPrivyAs(u.privyUserId, u.email);
    await jsonPost("/api/quests/invite-state/claim", { tier: 3 }, u.token);

    const quests = await questsList(u);
    const q = quests.find((x) => x.key === "invite-state");
    expect(q.tiered).toBe(true);
    expect(q.milestoneBaseWp).toBe(10);
    expect(q.ladder).toEqual([1, 3, 5, 10]);
    expect(q.progress).toBe(5);
    expect(q.claimedTiers).toEqual([3]);
    expect(q.claimableTiers).toEqual([1, 5]); // ≤5, not 3, not 10
  });
});

// ─── SECURITY: milestone quests are never honor-claimable ───────────────────
describe("SECURITY: unearned-mint exploit is closed", () => {
  test("plain claim on a milestone quest with zero progress mints nothing (404)", async () => {
    // Legacy (non-tiered) milestone quest.
    await testPrisma.quest.create({
      data: {
        key: "invite-5-friends",
        title: "Undang 5 teman",
        category: "INVITE",
        rewardWp: 250,
        cadence: "ONCE",
        targetCount: 5,
      },
    });
    const u = makeUser();
    const appUser = await provision(u); // zero invites

    mockPrivyAs(u.privyUserId, u.email);
    const res = await jsonPost("/api/quests/invite-5-friends/claim", {}, u.token);
    expect(res.status).toBe(404); // rejected — not honor-claimable

    // No WP minted, no completion written (so auto-award stays possible later).
    expect(await balanceOf(appUser.id)).toBe(0);
    const comp = await testPrisma.questCompletion.findFirst({
      where: { appUserId: appUser.id },
    });
    expect(comp).toBeNull();
    const refBonus = await testPrisma.wpLedger.findFirst({
      where: { type: "REFERRAL_BONUS" },
    });
    expect(refBonus).toBeNull();
  });

  test("tier claim on a non-tiered milestone quest → 404", async () => {
    await testPrisma.quest.create({
      data: {
        key: "redeem-3-times",
        title: "Tukar 3 kali",
        category: "REDEEM",
        rewardWp: 150,
        cadence: "ONCE",
        targetCount: 3,
      },
    });
    const u = makeUser();
    const appUser = await provision(u);
    mockPrivyAs(u.privyUserId, u.email);
    const res = await jsonPost("/api/quests/redeem-3-times/claim", { tier: 1 }, u.token);
    expect(res.status).toBe(404);
    expect(await balanceOf(appUser.id)).toBe(0);
  });
});

// ─── Referral %: a tier claim also credits the claimer's referrer ─────────────
describe("tier claims do NOT fire the referral hook (referral is regular-quest only)", () => {
  let seq = 0;
  async function directUser(opts: { referredById?: string; deposited?: boolean } = {}) {
    seq += 1;
    const uid = `${Date.now()}-tierref-${seq}`;
    return testPrisma.appUser.create({
      data: {
        privyId: `tierref-privy-${uid}`,
        email: `tierref-${uid}@test.com`,
        referralCode: `TIERREF${seq}${Date.now().toString(36).toUpperCase()}`.slice(0, 20),
        referredById: opts.referredById ?? null,
        hasDeposited: opts.deposited ?? false,
        qualifiedAt: opts.deposited ? new Date() : null,
      },
    });
  }

  test("referrer earns nothing when a referee claims a milestone tier", async () => {
    const referrer = await directUser(); // default rate 10%
    const referee = await directUser({ referredById: referrer.id, deposited: true });
    // One CONFIRMED on-chain redemption tied to the referee → REDEEM progress = 1.
    await seedConfirmedRedemption(referee.email, referee.id);
    const quest = await testPrisma.quest.create({
      data: {
        key: `redeem-tier-ref-${Date.now()}`,
        title: "Redeem (tiered)",
        category: "REDEEM",
        rewardWp: 0,
        cadence: "ONCE",
        targetCount: 1,
        milestoneBaseWp: 20,
        milestoneLadder: "1,3,5",
      },
    });

    const result = await claimMilestoneTier(referee.id, quest.key, 1);

    expect(result.tier).toBe(1);
    // Referee still gets base 20 + 10% self-bonus (deposited) = 22.
    expect(await balanceOf(referee.id)).toBe(22);
    // Referrer gets NOTHING: referral % is paid only on regular quest claims,
    // not on the referee's own milestone (INVITE/REDEEM) grinding.
    expect(result.referrerCredited).toBe(0);
    expect(await balanceOf(referrer.id)).toBe(0);
    const rows = await testPrisma.wpLedger.count({
      where: { appUserId: referrer.id, refType: "referral_quest" },
    });
    expect(rows).toBe(0);
  });

  test("claimAll claims every ready rung at once (M4)", async () => {
    const user = await directUser({ deposited: true });
    // 5 CONFIRMED redemptions → REDEEM progress = 5.
    for (let i = 0; i < 5; i++) await seedConfirmedRedemption(user.email, user.id);
    const quest = await testPrisma.quest.create({
      data: {
        key: `redeem-claimall-${Date.now()}`,
        title: "Redeem (tiered)",
        category: "REDEEM",
        rewardWp: 0,
        cadence: "ONCE",
        milestoneBaseWp: 10,
        milestoneLadder: "1,3,5,10",
      },
    });

    const res = await claimAllMilestoneTiers(user.id, quest.key);

    // Rungs 1,3,5 are ≤ progress 5 → all claimed at once (10 needs more).
    expect(res.tiers).toEqual([1, 3, 5]);
    // reward = (1+3+5)×10 = 90, + 10% self-bonus each (deposited) = 99.
    expect(await balanceOf(user.id)).toBe(99);
    // Re-running claims nothing new.
    const again = await claimAllMilestoneTiers(user.id, quest.key);
    expect(again.tiers).toEqual([]);
    expect(again.alreadyClaimed).toBe(true);
  });
});
