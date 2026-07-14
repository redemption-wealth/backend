import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { wibDateString } from "../lib/time.js";
import { creditWithTx, getBalance, WpCapExceededError } from "./wp.js";
import { isUniqueViolation } from "../lib/prisma-errors.js";

// Quest engine: daily check-in streak, honor-based task claims, and the
// per-user quest listing. All WP mutations run inside the same transaction as
// the completion write (via creditWithTx) so a claim and its credit are atomic.

// Check-in reward per streak day: day 1..7 → 1,2,4,8,16,32,64; capped at 64.
const CHECKIN_REWARDS = [1, 2, 4, 8, 16, 32, 64] as const;

export function checkinReward(streak: number): number {
  if (streak <= 0) return 0;
  return CHECKIN_REWARDS[Math.min(streak, CHECKIN_REWARDS.length) - 1]!;
}

export class QuestNotAvailableError extends Error {
  constructor(public questKey: string) {
    super(`Quest not available: ${questKey}`);
    this.name = "QuestNotAvailableError";
  }
}

// A WIB calendar date string ("YYYY-MM-DD") stored/compared at UTC midnight,
// matching the @db.Date convention used elsewhere.
function wibDateToUtcMidnight(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00Z`);
}

export interface CheckinResult {
  alreadyCheckedIn: boolean;
  streak: number;
  reward: number;
}

/**
 * Daily check-in. Idempotent per WIB day (second call same day credits nothing).
 * Streak continues if the last check-in was yesterday, else resets to 1.
 */
export async function checkin(appUserId: string): Promise<CheckinResult> {
  const today = wibDateString();

  return prisma.$transaction(async (tx) => {
    // Serialize check-ins for this user so a double-tap can't double-credit.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`checkin:${appUserId}`}))`;

    const existing = await tx.checkinStreak.findUnique({ where: { appUserId } });
    const lastStr = existing?.lastCheckinDate
      ? wibDateString(existing.lastCheckinDate)
      : null;

    if (lastStr === today) {
      return {
        alreadyCheckedIn: true,
        streak: existing?.currentStreak ?? 0,
        reward: 0,
      };
    }

    const yesterday = wibDateString(
      new Date(wibDateToUtcMidnight(today).getTime() - 86_400_000)
    );
    const newStreak =
      lastStr === yesterday ? (existing?.currentStreak ?? 0) + 1 : 1;
    const reward = checkinReward(newStreak);
    const todayDate = wibDateToUtcMidnight(today);

    await tx.checkinStreak.upsert({
      where: { appUserId },
      create: {
        appUserId,
        currentStreak: newStreak,
        lastCheckinDate: todayDate,
      },
      update: { currentStreak: newStreak, lastCheckinDate: todayDate },
    });

    await creditWithTx(tx, {
      appUserId,
      amount: reward,
      type: "CHECKIN",
      refType: "checkin",
      refId: today,
      note: `Daily check-in day ${newStreak}`,
    });

    return { alreadyCheckedIn: false, streak: newStreak, reward };
  });
}

export interface ClaimResult {
  alreadyClaimed: boolean;
  reward: number;
  base?: number;
  referralBonus?: number;
}

/**
 * Claim a task (honor-based). Idempotent per period (DAILY → per WIB day, ONCE →
 * forever) via the QuestCompletion unique key. Qualified users (hasDeposited)
 * get a +10% self-bonus on the base reward — see plan §2.
 */
export async function claimTask(
  appUserId: string,
  questKey: string
): Promise<ClaimResult> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`claim:${appUserId}:${questKey}`}))`;

    const quest = await tx.quest.findUnique({ where: { key: questKey } });
    if (!quest || !quest.isActive) {
      throw new QuestNotAvailableError(questKey);
    }

    const periodKey = quest.cadence === "DAILY" ? wibDateString() : "once";

    const done = await tx.questCompletion.findUnique({
      where: {
        appUserId_questId_periodKey: { appUserId, questId: quest.id, periodKey },
      },
      select: { id: true },
    });
    if (done) return { alreadyClaimed: true, reward: 0 };

    await tx.questCompletion.create({
      data: { appUserId, questId: quest.id, periodKey },
    });

    const user = await tx.appUser.findUnique({
      where: { id: appUserId },
      select: { hasDeposited: true },
    });
    const referralBonus = user?.hasDeposited
      ? Math.floor(quest.rewardWp * 0.1)
      : 0;
    const total = quest.rewardWp + referralBonus;

    await creditWithTx(tx, {
      appUserId,
      amount: total,
      type: "TASK",
      refType: "quest",
      refId: quest.id,
      note: quest.title,
    });

    return {
      alreadyClaimed: false,
      reward: total,
      base: quest.rewardWp,
      referralBonus,
    };
  });
}

/**
 * Reset the displayed streak to 0 for users who missed a day (last check-in
 * older than yesterday, WIB). Check-in itself already recomputes the streak
 * lazily; this just keeps the stored/displayed `currentStreak` honest. Runs
 * daily via cron and is idempotent.
 */
export async function expireStaleStreaks(): Promise<number> {
  const today = wibDateString();
  const yesterday = wibDateString(
    new Date(wibDateToUtcMidnight(today).getTime() - 86_400_000)
  );
  const cutoff = wibDateToUtcMidnight(yesterday); // stale if lastCheckinDate < yesterday
  const res = await prisma.checkinStreak.updateMany({
    where: { lastCheckinDate: { lt: cutoff }, currentStreak: { gt: 0 } },
    data: { currentStreak: 0 },
  });
  return res.count;
}

// ─── Milestone quests (INVITE / REDEEM) ──────────────────────────────────────
// Progress-based quests that complete once a running count reaches targetCount:
//   INVITE → this user's referrals who have qualified (referredById == user AND
//            qualifiedAt != null)
//   REDEEM → this user's WpRedemption rows with status FULFILLED
// Unlike DAILY/SOCIAL tasks these are not user-claimed; the engine auto-credits
// quest.rewardWp (type TASK, capped) and writes QuestCompletion(periodKey="once")
// the first time the target is met.

const MILESTONE_CATEGORIES = ["INVITE", "REDEEM"] as const;
type MilestoneCategory = (typeof MILESTONE_CATEGORIES)[number];

function isMilestoneCategory(category: string): category is MilestoneCategory {
  return (MILESTONE_CATEGORIES as readonly string[]).includes(category);
}

type CountClient = Pick<Prisma.TransactionClient, "appUser" | "wpRedemption">;

/** Current progress count for a milestone category (cheap COUNT). */
async function milestoneProgress(
  client: CountClient,
  appUserId: string,
  category: MilestoneCategory
): Promise<number> {
  if (category === "INVITE") {
    return client.appUser.count({
      where: { referredById: appUserId, qualifiedAt: { not: null } },
    });
  }
  return client.wpRedemption.count({
    where: { appUserId, status: "FULFILLED" },
  });
}

/**
 * Evaluate this user's INVITE/REDEEM milestone quests and auto-award any whose
 * target is now met. Idempotent: each award is guarded by an advisory lock +
 * the QuestCompletion unique key (periodKey "once"), matching claimTask/checkin.
 * Cheap enough to run lazily on every GET /api/quests. Triggered eagerly after a
 * referee qualifies and after a redemption is fulfilled.
 */
export async function evaluateMilestoneQuests(appUserId: string): Promise<void> {
  const quests = await prisma.quest.findMany({
    where: { isActive: true, category: { in: [...MILESTONE_CATEGORIES] } },
  });
  if (quests.length === 0) return;

  for (const quest of quests) {
    if (!isMilestoneCategory(quest.category)) continue;
    const progress = await milestoneProgress(prisma, appUserId, quest.category);
    if (progress < quest.targetCount) continue;

    try {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`milestone:${appUserId}:${quest.id}`}))`;

        const done = await tx.questCompletion.findUnique({
          where: {
            appUserId_questId_periodKey: {
              appUserId,
              questId: quest.id,
              periodKey: "once",
            },
          },
          select: { id: true },
        });
        if (done) return;

        await tx.questCompletion.create({
          data: { appUserId, questId: quest.id, periodKey: "once" },
        });
        await creditWithTx(tx, {
          appUserId,
          amount: quest.rewardWp,
          type: "TASK",
          refType: "quest",
          refId: quest.id,
          note: quest.title,
        });
      });
    } catch (e) {
      // Cap reached → roll back (no completion, no credit) and retry next eval.
      if (e instanceof WpCapExceededError) continue;
      // Raced another eval that already completed it → the unique key rolled us
      // back; nothing more to do.
      if (isUniqueViolation(e)) continue;
      throw e;
    }
  }
}

/** Quests + this user's completion state, balance, and check-in status. */
export async function listQuestsForUser(appUserId: string) {
  // Lazily award any milestone (INVITE/REDEEM) whose target is now met so the
  // listed progress + claimed flags below are always fresh.
  await evaluateMilestoneQuests(appUserId);

  const today = wibDateString();

  const quests = await prisma.quest.findMany({
    where: { isActive: true },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
  const completions = await prisma.questCompletion.findMany({
    where: { appUserId },
    select: { questId: true, periodKey: true },
  });
  const streak = await prisma.checkinStreak.findUnique({ where: { appUserId } });
  const balance = await getBalance(appUserId);

  const completedSet = new Set(
    completions.map((c) => `${c.questId}:${c.periodKey}`)
  );

  // Milestone progress per category (INVITE/REDEEM), computed once and reused so
  // the app can render "3/5". Only computed for categories actually present.
  const presentCategories = new Set(quests.map((q) => q.category));
  const progressByCategory: Partial<Record<MilestoneCategory, number>> = {};
  for (const category of MILESTONE_CATEGORIES) {
    if (presentCategories.has(category)) {
      progressByCategory[category] = await milestoneProgress(
        prisma,
        appUserId,
        category
      );
    }
  }

  const questStates = quests.map((q) => {
    const periodKey = q.cadence === "DAILY" ? today : "once";
    const milestone = isMilestoneCategory(q.category);
    return {
      id: q.id,
      key: q.key,
      title: q.title,
      description: q.description,
      category: q.category,
      rewardWp: q.rewardWp,
      cadence: q.cadence,
      targetCount: q.targetCount,
      actionUrl: q.actionUrl,
      claimed: completedSet.has(`${q.id}:${periodKey}`),
      // Milestone (INVITE/REDEEM) quests expose live progress for a "3/5" chip.
      ...(milestone
        ? {
            progress: progressByCategory[q.category as MilestoneCategory] ?? 0,
            target: q.targetCount,
          }
        : {}),
    };
  });

  const checkedInToday = streak?.lastCheckinDate
    ? wibDateString(streak.lastCheckinDate) === today
    : false;

  return {
    balance,
    checkin: {
      currentStreak: streak?.currentStreak ?? 0,
      checkedInToday,
      nextReward: checkinReward(checkedInToday ? (streak?.currentStreak ?? 0) : (streak?.currentStreak ?? 0) + 1),
    },
    quests: questStates,
  };
}
