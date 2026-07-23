import { describe, test, expect, vi, beforeEach } from "vitest";

vi.mock("@/db.js", () => {
  const models = {
    checkinStreak: { findUnique: vi.fn(), upsert: vi.fn(), updateMany: vi.fn() },
    quest: { findUnique: vi.fn(), findMany: vi.fn() },
    questCompletion: { findUnique: vi.fn(), create: vi.fn(), findMany: vi.fn() },
    appUser: { findUnique: vi.fn(), count: vi.fn() },
    redemption: { count: vi.fn() },
    wpLedger: { aggregate: vi.fn(), create: vi.fn() },
    appSettings: { findUnique: vi.fn() },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prisma: any = { ...models, $executeRaw: vi.fn() };
  prisma.$transaction = vi.fn((cb: (tx: unknown) => unknown) => cb(prisma));
  return { prisma };
});

import { prisma } from "@/db.js";
import { wibDateString } from "@/lib/time.js";
import {
  checkin,
  claimTask,
  checkinReward,
  expireStaleStreaks,
  evaluateMilestoneQuests,
  QuestNotAvailableError,
} from "@/services/quest.js";
import { WpCapExceededError } from "@/services/wp.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any;

const today = wibDateString();
const todayMidnight = new Date(`${today}T00:00:00Z`);
const yesterday = new Date(todayMidnight.getTime() - 86_400_000);
const threeDaysAgo = new Date(todayMidnight.getTime() - 3 * 86_400_000);

beforeEach(() => {
  vi.resetAllMocks();
  db.$transaction.mockImplementation((cb: (tx: unknown) => unknown) => cb(db));
  // creditWithTx dependencies (issuance cap + balance) — permissive defaults.
  db.appSettings.findUnique.mockResolvedValue({ wpMonthlyCapWp: 1_000_000 });
  db.wpLedger.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
  db.wpLedger.create.mockResolvedValue({ id: "ledger" });
  db.checkinStreak.upsert.mockResolvedValue({});
  db.questCompletion.create.mockResolvedValue({});
});

describe("checkinReward", () => {
  test("follows the 1,2,4,8,16,32,64 curve, capped at 64", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 30].map(checkinReward)).toEqual([
      1, 2, 4, 8, 16, 32, 64, 64, 64,
    ]);
  });
});

describe("checkin", () => {
  test("first check-in ever → streak 1, credits 1 WP", async () => {
    db.checkinStreak.findUnique.mockResolvedValue(null);

    const res = await checkin("u1");

    expect(res).toEqual({ alreadyCheckedIn: false, streak: 1, reward: 1 });
    expect(db.wpLedger.create).toHaveBeenCalledTimes(1);
    expect(db.wpLedger.create.mock.calls[0][0].data.amount).toBe(1);
  });

  test("second check-in the same day → no credit (idempotent)", async () => {
    db.checkinStreak.findUnique.mockResolvedValue({
      currentStreak: 3,
      lastCheckinDate: todayMidnight,
    });

    const res = await checkin("u1");

    expect(res.alreadyCheckedIn).toBe(true);
    expect(res.reward).toBe(0);
    expect(db.wpLedger.create).not.toHaveBeenCalled();
    expect(db.checkinStreak.upsert).not.toHaveBeenCalled();
  });

  test("consecutive day → streak increments", async () => {
    db.checkinStreak.findUnique.mockResolvedValue({
      currentStreak: 3,
      lastCheckinDate: yesterday,
    });

    const res = await checkin("u1");

    expect(res.streak).toBe(4);
    expect(res.reward).toBe(8); // day 4
    expect(db.wpLedger.create.mock.calls[0][0].data.amount).toBe(8);
  });

  test("missed a day → streak resets to 1", async () => {
    db.checkinStreak.findUnique.mockResolvedValue({
      currentStreak: 5,
      lastCheckinDate: threeDaysAgo,
    });

    const res = await checkin("u1");

    expect(res.streak).toBe(1);
    expect(res.reward).toBe(1);
  });

  test("edge: day-7 reward caps at 64 (streak 6 → 7)", async () => {
    db.checkinStreak.findUnique.mockResolvedValue({
      currentStreak: 6,
      lastCheckinDate: yesterday,
    });

    const res = await checkin("u1");

    expect(res.streak).toBe(7);
    expect(res.reward).toBe(64); // day 7 cap
    expect(db.wpLedger.create.mock.calls[0][0].data.amount).toBe(64);
  });

  test("propagates WpCapExceededError when the monthly issuance cap is hit", async () => {
    db.checkinStreak.findUnique.mockResolvedValue(null);
    // Issuance already at the cap → creditWithTx throws.
    db.appSettings.findUnique.mockResolvedValue({ wpMonthlyCapWp: 0 });
    db.wpLedger.aggregate.mockImplementation(({ where }: any) =>
      where?.type
        ? Promise.resolve({ _sum: { amount: 0 } }) // issued this month
        : Promise.resolve({ _sum: { amount: 0 } })
    );

    await expect(checkin("u1")).rejects.toBeInstanceOf(WpCapExceededError);
    expect(db.wpLedger.create).not.toHaveBeenCalled();
  });
});

describe("claimTask", () => {
  const quest = {
    id: "q1",
    key: "follow-x",
    isActive: true,
    cadence: "ONCE",
    rewardWp: 20,
    title: "Follow X",
  };

  test("first claim credits the base reward", async () => {
    db.quest.findUnique.mockResolvedValue(quest);
    db.questCompletion.findUnique.mockResolvedValue(null);
    db.appUser.findUnique.mockResolvedValue({ hasDeposited: false });

    const res = await claimTask("u1", "follow-x");

    expect(res).toEqual({
      alreadyClaimed: false,
      reward: 20,
      base: 20,
      referralBonus: 0,
      // No referrer on this user → no referral credit.
      referrerCredited: 0,
    });
    expect(db.questCompletion.create).toHaveBeenCalledTimes(1);
    expect(db.wpLedger.create.mock.calls[0][0].data.amount).toBe(20);
  });

  test("is idempotent within a period → no double credit", async () => {
    db.quest.findUnique.mockResolvedValue(quest);
    db.questCompletion.findUnique.mockResolvedValue({ id: "already" });

    const res = await claimTask("u1", "follow-x");

    expect(res.alreadyClaimed).toBe(true);
    expect(db.questCompletion.create).not.toHaveBeenCalled();
    expect(db.wpLedger.create).not.toHaveBeenCalled();
  });

  test("qualified user gets a +10% self-bonus", async () => {
    db.quest.findUnique.mockResolvedValue(quest);
    db.questCompletion.findUnique.mockResolvedValue(null);
    db.appUser.findUnique.mockResolvedValue({ hasDeposited: true });

    const res = await claimTask("u1", "follow-x");

    expect(res.reward).toBe(22); // 20 + floor(20*0.1)
    expect(res.referralBonus).toBe(2);
    expect(db.wpLedger.create.mock.calls[0][0].data.amount).toBe(22);
  });

  test("throws for a missing or inactive quest", async () => {
    db.quest.findUnique.mockResolvedValue(null);
    await expect(claimTask("u1", "nope")).rejects.toBeInstanceOf(
      QuestNotAvailableError
    );
  });

  test("SECURITY: rejects honor-claiming a milestone quest (no unearned mint)", async () => {
    db.quest.findUnique.mockResolvedValue({
      id: "qi",
      key: "invite-5-friends",
      isActive: true,
      category: "INVITE",
      cadence: "ONCE",
      rewardWp: 250,
      title: "Undang 5 teman",
    });

    await expect(
      claimTask("u1", "invite-5-friends")
    ).rejects.toBeInstanceOf(QuestNotAvailableError);
    // No completion written, no WP minted.
    expect(db.questCompletion.create).not.toHaveBeenCalled();
    expect(db.wpLedger.create).not.toHaveBeenCalled();
  });

  test("throws for an inactive (isActive:false) quest", async () => {
    db.quest.findUnique.mockResolvedValue({ ...quest, isActive: false });
    await expect(claimTask("u1", "follow-x")).rejects.toBeInstanceOf(
      QuestNotAvailableError
    );
  });

  test("DAILY cadence keys the completion by today's WIB date (not 'once')", async () => {
    db.quest.findUnique.mockResolvedValue({ ...quest, cadence: "DAILY" });
    db.questCompletion.findUnique.mockResolvedValue(null);
    db.appUser.findUnique.mockResolvedValue({ hasDeposited: false });

    await claimTask("u1", "follow-x");

    // The idempotency lookup + write use today's date as periodKey.
    expect(db.questCompletion.findUnique.mock.calls[0][0].where
      .appUserId_questId_periodKey.periodKey).toBe(today);
    expect(db.questCompletion.create.mock.calls[0][0].data.periodKey).toBe(today);
  });
});

describe("expireStaleStreaks", () => {
  test("resets streaks whose last check-in is older than yesterday", async () => {
    db.checkinStreak.updateMany.mockResolvedValue({ count: 3 });

    const count = await expireStaleStreaks();

    expect(count).toBe(3);
    const arg = db.checkinStreak.updateMany.mock.calls[0][0];
    expect(arg.data).toEqual({ currentStreak: 0 });
    expect(arg.where.currentStreak).toEqual({ gt: 0 });
    expect(arg.where.lastCheckinDate.lt).toBeInstanceOf(Date);
  });
});

describe("evaluateMilestoneQuests", () => {
  const inviteQuest = {
    id: "qi",
    key: "invite-5",
    title: "Undang 5 teman",
    category: "INVITE",
    rewardWp: 250,
    cadence: "ONCE",
    targetCount: 5,
  };
  const redeemQuest = {
    id: "qr",
    key: "redeem-3",
    title: "Tukar 3 kali",
    category: "REDEEM",
    rewardWp: 150,
    cadence: "ONCE",
    targetCount: 3,
  };

  test("INVITE: counts qualified referrals only", async () => {
    db.quest.findMany.mockResolvedValue([inviteQuest]);
    db.appUser.count.mockResolvedValue(5); // 5 qualified referrals
    db.questCompletion.findUnique.mockResolvedValue(null);

    await evaluateMilestoneQuests("u1");

    // progress met → completion written + reward credited
    expect(db.appUser.count.mock.calls[0][0].where).toEqual({
      referredById: "u1",
      qualifiedAt: { not: null },
    });
    expect(db.questCompletion.create).toHaveBeenCalledWith({
      data: { appUserId: "u1", questId: "qi", periodKey: "once" },
    });
    expect(db.wpLedger.create.mock.calls[0][0].data.amount).toBe(250);
    expect(db.wpLedger.create.mock.calls[0][0].data.type).toBe("TASK");
  });

  test("does not award below target", async () => {
    db.quest.findMany.mockResolvedValue([inviteQuest]);
    db.appUser.count.mockResolvedValue(4); // one short of 5

    await evaluateMilestoneQuests("u1");

    expect(db.questCompletion.create).not.toHaveBeenCalled();
    expect(db.wpLedger.create).not.toHaveBeenCalled();
  });

  test("does not re-award an already-completed milestone (idempotent)", async () => {
    db.quest.findMany.mockResolvedValue([redeemQuest]);
    db.appUser.findUnique.mockResolvedValue({ email: "u@test.com" });
    db.redemption.count.mockResolvedValue(3); // target met
    db.questCompletion.findUnique.mockResolvedValue({ id: "already" });

    await evaluateMilestoneQuests("u1");

    expect(db.questCompletion.create).not.toHaveBeenCalled();
    expect(db.wpLedger.create).not.toHaveBeenCalled();
  });

  test("REDEEM: counts CONFIRMED on-chain redemptions by email (no FK)", async () => {
    db.quest.findMany.mockResolvedValue([redeemQuest]);
    db.appUser.findUnique.mockResolvedValue({ email: "u@test.com" });
    db.redemption.count.mockResolvedValue(3);
    db.questCompletion.findUnique.mockResolvedValue(null);

    await evaluateMilestoneQuests("u1");

    expect(db.redemption.count.mock.calls[0][0].where).toEqual({
      userEmail: "u@test.com",
      status: "CONFIRMED",
    });
    expect(db.wpLedger.create.mock.calls[0][0].data.amount).toBe(150);
  });

  test("edge: exactly at target awards (progress === targetCount)", async () => {
    db.quest.findMany.mockResolvedValue([redeemQuest]);
    db.appUser.findUnique.mockResolvedValue({ email: "u@test.com" });
    db.redemption.count.mockResolvedValue(3); // exactly the target of 3
    db.questCompletion.findUnique.mockResolvedValue(null);

    await evaluateMilestoneQuests("u1");

    expect(db.questCompletion.create).toHaveBeenCalledTimes(1);
    expect(db.wpLedger.create).toHaveBeenCalledTimes(1);
  });

  test("skips TIERED milestones (milestoneBaseWp set) — those are user-claimed", async () => {
    db.quest.findMany.mockResolvedValue([
      { ...redeemQuest, milestoneBaseWp: 30, milestoneLadder: null },
    ]);
    db.appUser.findUnique.mockResolvedValue({ email: "u@test.com" });
    db.redemption.count.mockResolvedValue(100); // way past target

    await evaluateMilestoneQuests("u1");

    // Auto-award must NOT fire for tiered quests.
    expect(db.questCompletion.create).not.toHaveBeenCalled();
    expect(db.wpLedger.create).not.toHaveBeenCalled();
  });

  test("cap reached → swallows WpCapExceededError (no completion, retried later)", async () => {
    db.quest.findMany.mockResolvedValue([redeemQuest]);
    db.appUser.findUnique.mockResolvedValue({ email: "u@test.com" });
    db.redemption.count.mockResolvedValue(3); // target met
    db.questCompletion.findUnique.mockResolvedValue(null);
    // Issuance already at cap so creditWithTx throws WpCapExceededError.
    db.appSettings.findUnique.mockResolvedValue({ wpMonthlyCapWp: 0 });

    // Must NOT throw — the engine continues and leaves the milestone unclaimed.
    await expect(evaluateMilestoneQuests("u1")).resolves.toBeUndefined();
    expect(db.wpLedger.create).not.toHaveBeenCalled();
  });
});
