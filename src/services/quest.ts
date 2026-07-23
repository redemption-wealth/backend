import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { wibDateString } from "../lib/time.js";
import { creditWithTx, getBalance, WpCapExceededError } from "./wp.js";
import { creditReferrerForQuest } from "./referral.js";
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
  /** The claimer's own deposited self-bonus (+10%), not a referrer credit. */
  referralBonus?: number;
  /** WP minted to this user's referrer from this claim (0 if none). */
  referrerCredited?: number;
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

    // SECURITY: milestone quests (INVITE/REDEEM) are progress-gated. They are
    // NEVER honor-claimable — that would mint the full reward with zero progress
    // AND permanently satisfy the periodKey="once" completion the auto-award
    // relies on. Milestone WP is earned only via evaluateMilestoneQuests (legacy,
    // non-tiered) or claimMilestoneTier (tiered, progress-verified).
    if (isMilestoneCategory(quest.category)) {
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

    const completion = await tx.questCompletion.create({
      data: { appUserId, questId: quest.id, periodKey },
      select: { id: true },
    });

    const user = await tx.appUser.findUnique({
      where: { id: appUserId },
      select: { hasDeposited: true, referredById: true },
    });
    const selfBonus = user?.hasDeposited ? Math.floor(quest.rewardWp * 0.1) : 0;
    const total = quest.rewardWp + selfBonus;

    await creditWithTx(tx, {
      appUserId,
      amount: total,
      type: "TASK",
      refType: "quest",
      refId: quest.id,
      note: quest.title,
    });

    // Real-time referral: credit this user's referrer a % of the quest's base
    // reward (minted on top, best-effort — never fails this claim). See referral.ts.
    const referrerCredited = await creditReferrerForQuest(tx, {
      refereeId: appUserId,
      refereeReferredById: user?.referredById ?? null,
      refereeHasDeposited: user?.hasDeposited ?? false,
      basisWp: quest.rewardWp,
      sourceRefId: completion.id,
    });

    return {
      alreadyClaimed: false,
      reward: total,
      base: quest.rewardWp,
      referralBonus: selfBonus,
      referrerCredited,
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

type CountClient = Pick<Prisma.TransactionClient, "appUser" | "redemption">;

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
  // REDEEM → count this account's ON-CHAIN redemptions (the `redemption` model),
  // tied by appUserId (set at redeem time), mirroring userHasConfirmedRedemption
  // in appUser.ts. CONFIRMED means they actually sent $WEALTH on-chain. Counting
  // by appUserId (not the shared email) keeps the counter per-account/sybil-safe.
  return client.redemption.count({
    where: { appUserId, status: "CONFIRMED" },
  });
}

// ─── Tiered milestones (pure ladder maths) ───────────────────────────────────
// When a milestone quest sets `milestoneBaseWp`, it becomes TIERED + user-claimed:
// the user claims each ladder threshold once, earning tier × milestoneBaseWp WP.

/** Default ascending ladder used when a quest's milestoneLadder is null/empty. */
export const DEFAULT_MILESTONE_LADDER = "1,3,5,10,20,30,50,100";

/** Parse a CSV of thresholds → ascending, de-duped, positive ints. */
export function parseLadder(csv: string | null | undefined): number[] {
  const source = csv && csv.trim() !== "" ? csv : DEFAULT_MILESTONE_LADDER;
  const seen = new Set<number>();
  for (const part of source.split(",")) {
    const n = Number.parseInt(part.trim(), 10);
    if (Number.isInteger(n) && n > 0) seen.add(n);
  }
  return [...seen].sort((a, b) => a - b);
}

/** WP reward for claiming tier `tier` of a quest with the given base. */
export function tierReward(tier: number, milestoneBaseWp: number): number {
  return tier * milestoneBaseWp;
}

/**
 * Which ladder tiers are claimable right now: threshold ≤ progress and not yet
 * completed. Pure + unit-tested — the DB claim path re-checks against the real
 * count so a client can never claim a tier it hasn't earned.
 */
export function claimableTiers(
  progress: number,
  ladderCsv: string | null | undefined,
  completedTiers: number[]
): number[] {
  const done = new Set(completedTiers);
  return parseLadder(ladderCsv).filter((t) => t <= progress && !done.has(t));
}

/** Prefix marking a QuestCompletion.periodKey as a tier claim ("tier:5"). */
const TIER_PERIOD_PREFIX = "tier:";

/** Parse the tier number out of a "tier:N" periodKey, or null if not one. */
function tierFromPeriodKey(periodKey: string): number | null {
  if (!periodKey.startsWith(TIER_PERIOD_PREFIX)) return null;
  const n = Number.parseInt(periodKey.slice(TIER_PERIOD_PREFIX.length), 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Raised when a client asks to claim a tier whose threshold isn't met yet. */
export class TierLockedError extends Error {
  constructor(public questKey: string, public tier: number) {
    super(`Tier ${tier} locked for quest ${questKey}`);
    this.name = "TierLockedError";
  }
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
    // Tiered quests (milestoneBaseWp set) are USER-claimed via claimMilestoneTier,
    // not auto-awarded here. Legacy single-shot milestones keep auto-awarding.
    if (quest.milestoneBaseWp != null) continue;
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

export interface TierClaimResult {
  alreadyClaimed: boolean;
  reward: number;
  base?: number;
  referralBonus?: number;
  tier?: number;
  /** WP minted to this user's referrer from this tier claim (0 if none). */
  referrerCredited?: number;
}

/**
 * Claim a single tier of a TIERED milestone quest (one that sets milestoneBaseWp).
 * Progress-verified: rejects a tier whose threshold isn't met (TierLockedError).
 * Idempotent per tier via QuestCompletion(periodKey "tier:N"). Mirrors claimTask:
 * a deposited (qualified) user earns the +10% self-bonus on the tier reward, and
 * the credit flows through the same capped choke-point (creditWithTx, type TASK).
 */
export async function claimMilestoneTier(
  appUserId: string,
  questKey: string,
  tier: number
): Promise<TierClaimResult> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`tier:${appUserId}:${questKey}:${tier}`}))`;

    const quest = await tx.quest.findUnique({ where: { key: questKey } });
    if (!quest || !quest.isActive) throw new QuestNotAvailableError(questKey);
    // Only tiered milestone quests can be tier-claimed.
    if (!isMilestoneCategory(quest.category) || quest.milestoneBaseWp == null) {
      throw new QuestNotAvailableError(questKey);
    }
    // The tier must be a real rung of this quest's ladder.
    if (!parseLadder(quest.milestoneLadder).includes(tier)) {
      throw new TierLockedError(questKey, tier);
    }

    const periodKey = `${TIER_PERIOD_PREFIX}${tier}`;
    const done = await tx.questCompletion.findUnique({
      where: {
        appUserId_questId_periodKey: { appUserId, questId: quest.id, periodKey },
      },
      select: { id: true },
    });
    if (done) return { alreadyClaimed: true, reward: 0, tier };

    // NEVER trust the client tier: re-check against the real on-chain / referral
    // count. A tier is claimable only once progress has reached its threshold.
    const progress = await milestoneProgress(tx, appUserId, quest.category);
    if (progress < tier) throw new TierLockedError(questKey, tier);

    const completion = await tx.questCompletion.create({
      data: { appUserId, questId: quest.id, periodKey },
      select: { id: true },
    });

    const base = tierReward(tier, quest.milestoneBaseWp);
    const user = await tx.appUser.findUnique({
      where: { id: appUserId },
      select: { hasDeposited: true, referredById: true },
    });
    const referralBonus = user?.hasDeposited ? Math.floor(base * 0.1) : 0;
    const total = base + referralBonus;

    await creditWithTx(tx, {
      appUserId,
      amount: total,
      type: "TASK",
      refType: "quest",
      refId: quest.id,
      // Snapshot the tier + reward in the ledger note for audit.
      note: `${quest.title} — tier ${tier} (${base} WP)`,
    });

    // Tier claims are quest earnings too → credit the claimer's referrer a %
    // of the tier's base reward (same real-time, capped, best-effort path).
    const referrerCredited = await creditReferrerForQuest(tx, {
      refereeId: appUserId,
      refereeReferredById: user?.referredById ?? null,
      refereeHasDeposited: user?.hasDeposited ?? false,
      basisWp: base,
      sourceRefId: completion.id,
    });

    return {
      alreadyClaimed: false,
      reward: total,
      base,
      referralBonus,
      tier,
      referrerCredited,
    };
  });
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

  // Per-quest list of already-claimed tiers (from "tier:N" completions), so the
  // app can render each rung's claimed/claimable state for tiered milestones.
  const completedTiersByQuest = new Map<string, number[]>();
  for (const c of completions) {
    const t = tierFromPeriodKey(c.periodKey);
    if (t == null) continue;
    const list = completedTiersByQuest.get(c.questId) ?? [];
    list.push(t);
    completedTiersByQuest.set(c.questId, list);
  }

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
    const tiered = milestone && q.milestoneBaseWp != null;
    const progress = milestone
      ? progressByCategory[q.category as MilestoneCategory] ?? 0
      : 0;
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
      // Tiered milestones are claimed per-tier; the top-level `claimed` flag only
      // applies to the legacy single-shot ("once") milestones and DAILY/SOCIAL.
      claimed: tiered ? false : completedSet.has(`${q.id}:${periodKey}`),
      // Milestone (INVITE/REDEEM) quests expose live progress for a "3/5" chip.
      ...(milestone ? { progress, target: q.targetCount } : {}),
      // Tiered milestones additionally expose the full ladder + claim state so
      // the app can render each rung.
      ...(tiered
        ? {
            tiered: true,
            milestoneBaseWp: q.milestoneBaseWp,
            ladder: parseLadder(q.milestoneLadder),
            claimedTiers: (completedTiersByQuest.get(q.id) ?? []).sort(
              (a, b) => a - b
            ),
            claimableTiers: claimableTiers(
              progress,
              q.milestoneLadder,
              completedTiersByQuest.get(q.id) ?? []
            ),
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
