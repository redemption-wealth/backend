import { randomBytes } from "node:crypto";
import { prisma } from "../db.js";
import { creditWithTx, WpCapExceededError } from "./wp.js";
import { evaluateMilestoneQuests } from "./quest.js";
import { uniqueViolationOn } from "../lib/prisma-errors.js";

// End-user (AppUser) identity for the WEALTH Points gamification layer.
// Keyed to Privy (privyId). Distinct from the Better Auth `User` (admins only).
//
// Anti-bot gate: `hasDeposited` becomes true once the user has ≥1 CONFIRMED
// on-chain redemption (i.e. they actually sent $WEALTH). Redeeming WP for real
// rewards and paying referral bonuses are gated on this — see the plan §2.

// Unambiguous alphabet (no I, O, 0, 1) for human-shareable referral codes.
const REFERRAL_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const REFERRAL_CODE_LEN = 8;

function randomChars(len: number): string {
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) {
    out += REFERRAL_ALPHABET[bytes[i]! % REFERRAL_ALPHABET.length];
  }
  return out;
}

// Length of the random suffix appended after a vanity (name) prefix.
const REFERRAL_SUFFIX_LEN = 4;

/**
 * Generate a referral code. When a `seed` (name or email) is supplied we build a
 * vanity code — an uppercased letter prefix from the seed + a random suffix, e.g.
 * "WISNU7K3M" — which is more memorable/shareable (the pattern Airbnb, Poshmark,
 * etc. use) while the suffix still guarantees uniqueness. Seeds with no usable
 * letters (or none supplied) fall back to a pure-random code. Codes are matched
 * case-insensitively (resolveReferrerId uppercases), so we always emit uppercase.
 */
export function generateReferralCode(seed?: string): string {
  const prefix = (seed ?? "")
    .split("@")[0]! // drop the email domain if an email was passed
    .toUpperCase()
    .replace(/[^A-Z]/g, "") // letters only; keeps names readable
    .slice(0, 6);
  if (prefix.length >= 2) return prefix + randomChars(REFERRAL_SUFFIX_LEN);
  return randomChars(REFERRAL_CODE_LEN);
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
      await maybePayReferralBonuses(appUser.id, appUser.referredById);
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
    await maybePayReferralBonuses(appUser.id, appUser.referredById);
    // This referee qualifying may complete the referrer's INVITE milestone.
    await evaluateMilestoneQuests(appUser.referredById);
  }
  return appUser;
}

// Flat referral bonuses (fallbacks when AppSettings has no row yet). The live
// values are read from AppSettings so a manager can tune them without a deploy.
// Both are paid ONCE, only when the referee first deposits (anti-bot gate).
export const REFERRER_BONUS_WP_DEFAULT = 50; // paid to the referrer
export const REFEREE_WELCOME_WP_DEFAULT = 50; // paid to the referee (welcome)

/** Mask an email for display: "andini@gmail.com" → "and***@gmail.com". */
function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at);
  const shown = local.slice(0, Math.min(3, local.length));
  return `${shown}***${domain}`;
}

/** Referral tab data: code, headline stats, joined friends, and code-entry state. */
export async function getReferralInfo(appUserId: string) {
  const me = await prisma.appUser.findUnique({
    where: { id: appUserId },
    select: { referralCode: true, referredById: true, hasDeposited: true },
  });

  const settings = await prisma.appSettings.findUnique({
    where: { id: "singleton" },
    select: { wpReferrerBonusWp: true, wpRefereeWelcomeWp: true },
  });
  const referrerBonusWp = settings?.wpReferrerBonusWp ?? REFERRER_BONUS_WP_DEFAULT;
  const refereeWelcomeWp = settings?.wpRefereeWelcomeWp ?? REFEREE_WELCOME_WP_DEFAULT;

  const friends = await prisma.appUser.findMany({
    where: { referredById: appUserId },
    select: { id: true, email: true, hasDeposited: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });

  // Per-friend + total bonus earned AS A REFERRER (refType "referral"). The
  // referee's own welcome bonus uses refType "referral_welcome" and is excluded.
  const bonuses = await prisma.wpLedger.findMany({
    where: { appUserId, type: "REFERRAL_BONUS", refType: "referral" },
    select: { refId: true, amount: true },
  });
  const bonusByReferee = new Map(bonuses.map((b) => [b.refId, b.amount]));
  const bonusWpReceived = bonuses.reduce((sum, b) => sum + b.amount, 0);

  const hasReferrer = me?.referredById != null;

  return {
    referralCode: me?.referralCode ?? null,
    // A user can still attach a friend's code only if they haven't set one yet
    // AND haven't qualified yet (the bonus is paid at qualification).
    hasReferrer,
    canApplyCode: !hasReferrer && !(me?.hasDeposited ?? false),
    stats: {
      friendsJoined: friends.length,
      bonusWpReceived,
      referrerBonusWp,
      refereeWelcomeWp,
    },
    friends: friends.map((f) => ({
      label: maskEmail(f.email),
      joinedAt: f.createdAt,
      qualified: f.hasDeposited,
      bonusWp: bonusByReferee.get(f.id) ?? 0,
    })),
  };
}

export class ReferralCodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReferralCodeError";
  }
}

/**
 * Manually attach a friend's referral code to the current user. This is the
 * fallback for users who got a code by word-of-mouth (the link path sets it
 * automatically). Rules: set-once (can't change an existing referrer), only
 * before the user qualifies (deposits), no self-referral, code must exist.
 * No bonus is paid here — it is still paid later, when the user deposits.
 */
export async function applyReferralCode(appUserId: string, rawCode: string) {
  const me = await prisma.appUser.findUnique({
    where: { id: appUserId },
    select: { id: true, referredById: true, hasDeposited: true },
  });
  if (!me) throw new ReferralCodeError("Pengguna tidak ditemukan");
  if (me.referredById) throw new ReferralCodeError("Kamu sudah memakai kode referral");
  if (me.hasDeposited)
    throw new ReferralCodeError("Kode referral hanya bisa dipakai sebelum deposit pertama");

  const referrerId = await resolveReferrerId(rawCode);
  if (!referrerId) throw new ReferralCodeError("Kode referral tidak valid");
  if (referrerId === appUserId)
    throw new ReferralCodeError("Tidak bisa memakai kode referral sendiri");

  await prisma.appUser.update({
    where: { id: appUserId },
    data: { referredById: referrerId },
  });
  return getReferralInfo(appUserId);
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
        // Seed the vanity prefix from the email local-part (no name at signup).
        data: { ...data, referralCode: generateReferralCode(data.email) },
      });
    } catch (e) {
      // Robust across Prisma versions: reads both meta.target and the PrismaPg
      // driver-adapter constraint shape.
      const isCodeCollision = uniqueViolationOn(e, "referralCode");
      if (isCodeCollision && attempt < MAX_ATTEMPTS - 1) continue;
      throw e;
    }
  }
  throw new Error("Failed to generate a unique referral code");
}

/**
 * One-time referral payout, run when a referee first qualifies (deposits):
 *   1. Referrer gets a FLAT bonus (`wpReferrerBonusWp`).
 *   2. Referee gets a FLAT welcome bonus (`wpRefereeWelcomeWp`).
 *
 * Both are idempotent (one ledger row each) and gated on the referee actually
 * depositing — the core anti-sybil defence (plan §2): a ring of empty bot
 * accounts that never deposit yields nothing. Flat (not "% of balance") so the
 * payout is predictable and can't be inflated by farming WP before depositing.
 * Routed through creditWithTx so both count against the monthly issuance cap; a
 * cap hit lapses that leg gracefully instead of failing the whole sync.
 */
async function maybePayReferralBonuses(refereeId: string, referrerId: string) {
  await prisma.$transaction(async (tx) => {
    // Serialize per referee so two concurrent qualify-syncs can't double-pay.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`refbonus:${refereeId}`}))`;

    const settings = await tx.appSettings.findUnique({
      where: { id: "singleton" },
      select: { wpReferrerBonusWp: true, wpRefereeWelcomeWp: true },
    });
    const referrerBonus = settings?.wpReferrerBonusWp ?? REFERRER_BONUS_WP_DEFAULT;
    const refereeWelcome = settings?.wpRefereeWelcomeWp ?? REFEREE_WELCOME_WP_DEFAULT;

    // 1. Referrer flat bonus — dedup: one "referral" row per referee, on the referrer.
    if (referrerBonus > 0) {
      const paid = await tx.wpLedger.findFirst({
        where: {
          appUserId: referrerId,
          type: "REFERRAL_BONUS",
          refType: "referral",
          refId: refereeId,
        },
        select: { id: true },
      });
      if (!paid) {
        try {
          await creditWithTx(tx, {
            appUserId: referrerId,
            amount: referrerBonus,
            type: "REFERRAL_BONUS",
            refType: "referral",
            refId: refereeId,
            note: "Bonus referral: teman deposit",
          });
        } catch (e) {
          if (!(e instanceof WpCapExceededError)) throw e; // cap hit → lapse this leg
        }
      }
    }

    // 2. Referee flat welcome — dedup: one "referral_welcome" row on the referee.
    if (refereeWelcome > 0) {
      const paid = await tx.wpLedger.findFirst({
        where: {
          appUserId: refereeId,
          type: "REFERRAL_BONUS",
          refType: "referral_welcome",
        },
        select: { id: true },
      });
      if (!paid) {
        try {
          await creditWithTx(tx, {
            appUserId: refereeId,
            amount: refereeWelcome,
            type: "REFERRAL_BONUS",
            refType: "referral_welcome",
            refId: referrerId,
            note: "Welcome bonus: pakai kode referral",
          });
        } catch (e) {
          if (!(e instanceof WpCapExceededError)) throw e; // cap hit → lapse this leg
        }
      }
    }
  });
}
