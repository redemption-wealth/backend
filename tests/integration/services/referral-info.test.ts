import { describe, it, expect, beforeEach } from "vitest";
import { testPrisma } from "../../setup.integration.js";
import { getReferralInfo } from "@/services/appUser.js";
import { claimTask } from "@/services/quest.js";

/**
 * Phase 1 — Referral tab data (getReferralInfo) under the new percentage model.
 * Real DB, no mocks. Earnings come from referees' quest claims (refType
 * "referral_quest") and are attributed back to each friend via the claim's
 * QuestCompletion id.
 */

let seq = 0;
async function createUser(opts: {
  hasDeposited?: boolean;
  referredById?: string | null;
  referralRateBps?: number;
} = {}) {
  seq += 1;
  return testPrisma.appUser.create({
    data: {
      privyId: `privy-${seq}`,
      email: `friend${seq}@gmail.com`,
      referralCode: `REF${seq}`,
      hasDeposited: opts.hasDeposited ?? false,
      referredById: opts.referredById ?? null,
      ...(opts.referralRateBps !== undefined ? { referralRateBps: opts.referralRateBps } : {}),
    },
  });
}

let questSeq = 0;
async function createQuest(rewardWp: number) {
  questSeq += 1;
  return testPrisma.quest.create({
    data: {
      key: `quest-${questSeq}`,
      title: `Quest ${questSeq}`,
      description: "Follow us",
      category: "SOCIAL",
      rewardWp,
      cadence: "ONCE",
    },
  });
}

beforeEach(async () => {
  await testPrisma.wpLedger.deleteMany();
  await testPrisma.questCompletion.deleteMany();
  await testPrisma.checkinStreak.deleteMany();
  await testPrisma.wpRedemption.deleteMany();
  await testPrisma.wpConversion.deleteMany();
  await testPrisma.quest.deleteMany();
  await testPrisma.appUser.deleteMany();
});

describe("getReferralInfo (percentage model)", () => {
  it("returns code, default 10% rate, and empty stats for a fresh user", async () => {
    const user = await createUser();

    const info = await getReferralInfo(user.id);

    expect(info.referralCode).toBe(user.referralCode);
    expect(info.ratePercent).toBe(10); // default 1000 bps
    expect(info.hasReferrer).toBe(false);
    expect(info.canApplyCode).toBe(true);
    expect(info.stats).toEqual({ friendsJoined: 0, referralWpEarned: 0 });
    expect(info.friends).toEqual([]);
  });

  it("reports a KOL's higher rate", async () => {
    const kol = await createUser({ referralRateBps: 4000 });
    const info = await getReferralInfo(kol.id);
    expect(info.ratePercent).toBe(40);
  });

  it("aggregates referral earnings and attributes them per friend", async () => {
    const referrer = await createUser();
    const active = await createUser({ hasDeposited: true, referredById: referrer.id });
    const idle = await createUser({ hasDeposited: false, referredById: referrer.id });
    const quest = await createQuest(100);

    // Only the deposited friend claims → referrer earns 10, attributed to `active`.
    await claimTask(active.id, quest.key);

    const info = await getReferralInfo(referrer.id);

    expect(info.stats.friendsJoined).toBe(2);
    expect(info.stats.referralWpEarned).toBe(10);
    // Friends are newest-first; assert by matching email mask.
    const activeRow = info.friends.find((f) => f.label.startsWith("fri") && f.qualified);
    const idleRow = info.friends.find((f) => !f.qualified);
    expect(activeRow?.contributedWp).toBe(10);
    expect(activeRow?.qualified).toBe(true);
    expect(idleRow?.contributedWp).toBe(0);
    expect(idleRow?.qualified).toBe(false);
    // Emails are masked.
    expect(info.friends[0]!.label).toMatch(/\*\*\*@/);
    void idle;
  });

  it("blocks code entry once the user has a referrer or has deposited", async () => {
    const referrer = await createUser();
    const withReferrer = await createUser({ referredById: referrer.id });
    const deposited = await createUser({ hasDeposited: true });

    expect((await getReferralInfo(withReferrer.id)).canApplyCode).toBe(false);
    expect((await getReferralInfo(deposited.id)).canApplyCode).toBe(false);
  });
});
