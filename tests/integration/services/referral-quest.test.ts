import { describe, it, expect, beforeEach } from "vitest";
import { testPrisma } from "../../setup.integration.js";
import { claimTask } from "@/services/quest.js";

/**
 * Phase 1 — Referral percentage. Real DB, no data mocks.
 * When a referee claims a quest, their referrer is credited floor(base × rate)
 * WP in real time, minted on top (referee keeps their full reward). Gated on the
 * referee having deposited, skips flagged referrers, zero-rounding, cap hits, and
 * duplicates — none of which may roll back the referee's own claim.
 */

let seq = 0;
async function createUser(opts: {
  hasDeposited?: boolean;
  referredById?: string | null;
  referralRateBps?: number;
  flagged?: boolean;
} = {}) {
  seq += 1;
  return testPrisma.appUser.create({
    data: {
      privyId: `privy-${seq}`,
      email: `u${seq}@test.local`,
      referralCode: `REF${seq}`,
      hasDeposited: opts.hasDeposited ?? false,
      referredById: opts.referredById ?? null,
      ...(opts.referralRateBps !== undefined ? { referralRateBps: opts.referralRateBps } : {}),
      ...(opts.flagged ? { fraudReviewStatus: "FLAGGED" } : {}),
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

async function balanceOf(appUserId: string): Promise<number> {
  const agg = await testPrisma.wpLedger.aggregate({
    _sum: { amount: true },
    where: { appUserId },
  });
  return agg._sum.amount ?? 0;
}

async function referralRows(referrerId: string) {
  return testPrisma.wpLedger.findMany({
    where: { appUserId: referrerId, type: "REFERRAL_BONUS", refType: "referral_quest" },
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
  await testPrisma.appSettings.deleteMany();
});

describe("referral percentage on quest claim", () => {
  it("credits the referrer 10% (default rate) when a deposited referee claims", async () => {
    const referrer = await createUser();
    const referee = await createUser({ hasDeposited: true, referredById: referrer.id });
    const quest = await createQuest(100);

    await claimTask(referee.id, quest.key);

    // Referrer minted 10 (floor(100 * 0.10)); exactly one referral row.
    const rows = await referralRows(referrer.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount).toBe(10);
    expect(rows[0]!.refId).toBeTruthy();
    // Referee keeps their full reward (100 base + 10 own deposited self-bonus).
    expect(await balanceOf(referee.id)).toBe(110);
  });

  it("uses a KOL's higher rate (40%)", async () => {
    const kol = await createUser({ referralRateBps: 4000 });
    const referee = await createUser({ hasDeposited: true, referredById: kol.id });
    const quest = await createQuest(100);

    await claimTask(referee.id, quest.key);

    expect(await balanceOf(kol.id)).toBe(40);
  });

  // ── negative ──────────────────────────────────────────────────────────────
  it("credits nothing when the referee has no referrer", async () => {
    const soloUser = await createUser({ hasDeposited: true });
    const quest = await createQuest(100);

    await claimTask(soloUser.id, quest.key);

    // Only the user's own TASK credit exists — no referral rows anywhere.
    const anyReferral = await testPrisma.wpLedger.count({ where: { refType: "referral_quest" } });
    expect(anyReferral).toBe(0);
  });

  it("credits nothing until the referee has deposited (anti self-referral farming)", async () => {
    const referrer = await createUser();
    const referee = await createUser({ hasDeposited: false, referredById: referrer.id });
    const quest = await createQuest(100);

    await claimTask(referee.id, quest.key);

    expect(await balanceOf(referrer.id)).toBe(0);
    // Referee still earns their base (no self-bonus since not deposited).
    expect(await balanceOf(referee.id)).toBe(100);
  });

  it("credits nothing when the referrer is fraud-flagged", async () => {
    const flagged = await createUser({ flagged: true });
    const referee = await createUser({ hasDeposited: true, referredById: flagged.id });
    const quest = await createQuest(100);

    await claimTask(referee.id, quest.key);

    expect(await balanceOf(flagged.id)).toBe(0);
  });

  // ── edge ──────────────────────────────────────────────────────────────────
  it("writes no ledger row when the rounded bonus is zero", async () => {
    const referrer = await createUser(); // 10%
    const referee = await createUser({ hasDeposited: true, referredById: referrer.id });
    const quest = await createQuest(5); // floor(5 * 0.10) = 0

    await claimTask(referee.id, quest.key);

    expect(await referralRows(referrer.id)).toHaveLength(0);
    expect(await balanceOf(referrer.id)).toBe(0);
  });

  it("is idempotent: re-claiming a once-quest credits the referrer only once", async () => {
    const referrer = await createUser();
    const referee = await createUser({ hasDeposited: true, referredById: referrer.id });
    const quest = await createQuest(100);

    await claimTask(referee.id, quest.key);
    const second = await claimTask(referee.id, quest.key);

    expect(second.alreadyClaimed).toBe(true);
    expect(await referralRows(referrer.id)).toHaveLength(1);
    expect(await balanceOf(referrer.id)).toBe(10);
  });

  it("lapses the referrer bonus (but not the referee's claim) when the monthly cap is hit", async () => {
    // Cap fits the referee's 110 but not the extra 10 for the referrer.
    await testPrisma.appSettings.create({
      data: { id: "singleton", wpMonthlyCapWp: 115 },
    });
    const referrer = await createUser();
    const referee = await createUser({ hasDeposited: true, referredById: referrer.id });
    const quest = await createQuest(100);

    await claimTask(referee.id, quest.key);

    expect(await balanceOf(referee.id)).toBe(110); // referee unaffected
    expect(await balanceOf(referrer.id)).toBe(0); // referrer bonus lapsed
  });

  // ── concurrency ─────────────────────────────────────────────────────────────
  it("handles many referees of one KOL claiming concurrently: exact totals, no dupes", async () => {
    const kol = await createUser({ referralRateBps: 1000 });
    const quest = await createQuest(100);
    const referees = await Promise.all(
      Array.from({ length: 12 }, () =>
        createUser({ hasDeposited: true, referredById: kol.id }),
      ),
    );

    await Promise.all(referees.map((r) => claimTask(r.id, quest.key)));

    const rows = await referralRows(kol.id);
    expect(rows).toHaveLength(12); // one per referee, no duplicates
    expect(await balanceOf(kol.id)).toBe(120); // 12 × 10
  });
});
