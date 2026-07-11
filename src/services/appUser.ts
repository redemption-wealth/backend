import { randomBytes } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { creditWithTx, WpCapExceededError } from "./wp.js";
import { evaluateMilestoneQuests } from "./quest.js";

// End-user (AppUser) identity for the WEALTH Points gamification layer.
// Keyed to Privy (privyId). Distinct from the Better Auth `User` (admins only).
//
// Anti-bot gate: `hasDeposited` becomes true once the user has ≥1 CONFIRMED
// on-chain redemption (i.e. they actually sent $WEALTH). Redeeming WP for real
// rewards and paying referral bonuses are gated on this — see the plan §2.

// Unambiguous alphabet (no I, O, 0, 1) for human-shareable referral codes.
const REFERRAL_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const REFERRAL_CODE_LEN = 8;

export function generateReferralCode(len = REFERRAL_CODE_LEN): string {
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) {
    out += REFERRAL_ALPHABET[bytes[i]! % REFERRAL_ALPHABET.length];
  }
  return out;
}

export interface SyncAppUserInput {
  privyUserId: string;
  userEmail: string;
  walletAddress?: string | null;
}

/**
 * Upsert the AppUser for a Privy identity. Idempotent: safe to call on every
 * authenticated request. On first sight it generates a referral code and, if a
 * referral code was supplied, records the referrer (set-once). It also keeps
 * `hasDeposited`/`qualifiedAt` in sync and, when a user first qualifies, pays
 * the one-time referral bonus to their referrer.
 */
export async function syncAppUser(
  input: SyncAppUserInput,
  referralCode?: string | null
) {
  const { privyUserId, userEmail } = input;
  const walletAddress = input.walletAddress ?? null;

  const hasDeposited = await userHasConfirmedRedemption(userEmail);
  const existing = await prisma.appUser.findUnique({
    where: { privyId: privyUserId },
  });

  if (!existing) {
    const referredById = referralCode
      ? await resolveReferrerId(referralCode)
      : null;
    const appUser = await createAppUserWithUniqueCode({
      privyId: privyUserId,
      email: userEmail,
      walletAddress,
      referredById,
      hasDeposited,
      qualifiedAt: hasDeposited ? new Date() : null,
    });
    if (hasDeposited && appUser.referredById) {
      await maybePayReferralBonus(appUser.id, appUser.referredById);
      // This referee qualifying may complete the referrer's INVITE milestone.
      await evaluateMilestoneQuests(appUser.referredById);
    }
    return appUser;
  }

  // referredById is set-once; never overwritten on later syncs.
  const justQualified = !existing.hasDeposited && hasDeposited;
  const appUser = await prisma.appUser.update({
    where: { id: existing.id },
    data: {
      email: userEmail,
      walletAddress,
      ...(justQualified ? { hasDeposited: true, qualifiedAt: new Date() } : {}),
    },
  });
  if (justQualified && appUser.referredById) {
    await maybePayReferralBonus(appUser.id, appUser.referredById);
    // This referee qualifying may complete the referrer's INVITE milestone.
    await evaluateMilestoneQuests(appUser.referredById);
  }
  return appUser;
}

// Referral bonus rate paid to the referrer (of the referee's WP). Kept here so
// the API and the payout logic stay in sync.
export const REFERRAL_RATE_PERCENT = 10;

/** Mask an email for display: "andini@gmail.com" → "and***@gmail.com". */
function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at);
  const shown = local.slice(0, Math.min(3, local.length));
  return `${shown}***${domain}`;
}

/** Referral tab data: code, headline stats, and the list of joined friends. */
export async function getReferralInfo(appUserId: string) {
  const me = await prisma.appUser.findUnique({
    where: { id: appUserId },
    select: { referralCode: true },
  });

  const friends = await prisma.appUser.findMany({
    where: { referredById: appUserId },
    select: { id: true, email: true, hasDeposited: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });

  const bonuses = await prisma.wpLedger.findMany({
    where: { appUserId, type: "REFERRAL_BONUS", refType: "referral" },
    select: { refId: true, amount: true },
  });
  const bonusByReferee = new Map(bonuses.map((b) => [b.refId, b.amount]));
  const bonusWpReceived = bonuses.reduce((sum, b) => sum + b.amount, 0);

  return {
    referralCode: me?.referralCode ?? null,
    stats: {
      friendsJoined: friends.length,
      bonusWpReceived,
      ratePercent: REFERRAL_RATE_PERCENT,
    },
    friends: friends.map((f) => ({
      label: maskEmail(f.email),
      joinedAt: f.createdAt,
      qualified: f.hasDeposited,
      bonusWp: bonusByReferee.get(f.id) ?? 0,
    })),
  };
}

/**
 * Cheap path for read/claim endpoints: return the existing AppUser or provision
 * one on first sight. Avoids the full deposit-recheck + referral work of
 * syncAppUser on every request — that runs on the dedicated /sync endpoint.
 */
export async function getOrCreateAppUser(input: SyncAppUserInput) {
  const existing = await prisma.appUser.findUnique({
    where: { privyId: input.privyUserId },
  });
  if (existing) return existing;
  return syncAppUser(input);
}

async function userHasConfirmedRedemption(userEmail: string): Promise<boolean> {
  const count = await prisma.redemption.count({
    where: { userEmail, status: "CONFIRMED" },
  });
  return count > 0;
}

async function resolveReferrerId(code: string): Promise<string | null> {
  const ref = await prisma.appUser.findUnique({
    where: { referralCode: code.trim().toUpperCase() },
    select: { id: true },
  });
  return ref?.id ?? null;
}

interface CreateAppUserData {
  privyId: string;
  email: string;
  walletAddress: string | null;
  referredById: string | null;
  hasDeposited: boolean;
  qualifiedAt: Date | null;
}

// Create with a generated referral code, retrying on the (rare) unique-code
// collision. Uniqueness is guaranteed by the DB constraint, not by hope.
async function createAppUserWithUniqueCode(data: CreateAppUserData) {
  const MAX_ATTEMPTS = 5;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await prisma.appUser.create({
        data: { ...data, referralCode: generateReferralCode() },
      });
    } catch (e) {
      const isCodeCollision =
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === "P2002" &&
        (e.meta?.["target"] as string[] | undefined)?.includes("referralCode");
      if (isCodeCollision && attempt < MAX_ATTEMPTS - 1) continue;
      throw e;
    }
  }
  throw new Error("Failed to generate a unique referral code");
}

/**
 * One-time referral bonus: when a referee first qualifies (deposits), credit
 * their referrer 10% of the referee's current WP balance. Idempotent — guarded
 * by a single REFERRAL_BONUS ledger row per referee. Gating the payout on the
 * referee actually depositing is the core anti-sybil defence (plan §2).
 *
 * The bonus is a ONE-TIME snapshot of 10% of the referee's balance AT the moment
 * of qualification (not a running share of future earnings). This is intentional:
 * it is paid out of WP the referee has genuinely earned, and only after the
 * referee has itself deposited — so a sybil ring of empty bot accounts yields
 * nothing to skim. Routed through creditWithTx so the bonus counts against the
 * monthly issuance cap (assertUnderMonthlyCap) like every other REFERRAL_BONUS.
 */
async function maybePayReferralBonus(refereeId: string, referrerId: string) {
  await prisma.$transaction(async (tx) => {
    // Serialize per referee so two concurrent qualify-syncs can't double-pay.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`refbonus:${refereeId}`}))`;

    const already = await tx.wpLedger.findFirst({
      where: { type: "REFERRAL_BONUS", refType: "referral", refId: refereeId },
      select: { id: true },
    });
    if (already) return;

    const agg = await tx.wpLedger.aggregate({
      _sum: { amount: true },
      where: { appUserId: refereeId },
    });
    const refereeBalance = agg._sum.amount ?? 0;
    const bonus = Math.floor(refereeBalance * 0.1);
    if (bonus <= 0) return;

    try {
      await creditWithTx(tx, {
        appUserId: referrerId,
        amount: bonus,
        type: "REFERRAL_BONUS",
        refType: "referral",
        refId: refereeId,
        note: "10% referral qualification bonus",
      });
    } catch (e) {
      // Monthly issuance cap reached — skip the bonus for this month rather than
      // failing the whole sync. It stays unpaid (no ledger row) and is retried on
      // the next qualify-sync while the referee is still !hasDeposited... but that
      // flips once, so in practice it simply lapses if the cap is full — an
      // accepted trade-off for keeping issuance bounded.
      if (e instanceof WpCapExceededError) return;
      throw e;
    }
  });
}
