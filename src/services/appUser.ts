import { randomBytes } from "node:crypto";
import { prisma } from "../db.js";
import { evaluateMilestoneQuests } from "./quest.js";
import { DEFAULT_REFERRAL_RATE_BPS } from "./referral.js";
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
 * `hasDeposited`/`qualifiedAt` in sync and, when a user first qualifies,
 * evaluates their referrer's INVITE milestone.
 */
export async function syncAppUser(
  input: SyncAppUserInput,
  referralCode?: string | null
) {
  const { privyUserId, userEmail } = input;
  // Normalized for the transfer matcher's wallet→user lookup.
  const walletAddress = input.walletAddress?.toLowerCase() ?? null;

  const existing = await prisma.appUser.findUnique({
    where: { privyId: privyUserId },
  });

  if (!existing) {
    // A brand-new account has no redemptions tied to it yet, so it can't be
    // qualified. It qualifies on a LATER sync once THIS account has its own
    // CONFIRMED redemption — qualification is per-account, never per shared email.
    const referredById = referralCode
      ? await resolveReferrerId(referralCode)
      : null;
    return createAppUserWithUniqueCode({
      privyId: privyUserId,
      email: userEmail,
      walletAddress,
      referredById,
      hasDeposited: false,
      qualifiedAt: null,
    });
  }

  // Eligibility is LIVE-derived from THIS account's CONFIRMED redemptions
  // (appUserId, not the shared email — see confirmedRedemptionCount). The stored
  // hasDeposited/qualifiedAt columns are vestigial and no longer written here.
  const deposited = await hasRedeemed(existing.id);
  const appUser = await prisma.appUser.update({
    where: { id: existing.id },
    data: {
      email: userEmail,
      // Only ever ADD/refresh a wallet — a sync fired before the embedded
      // wallet exists must not wipe a stored address to NULL. The wallet is
      // the transfer matcher's key to pair treasury inflows with users
      // (2026-07-17 lost-redemption case: this exact wipe left the matcher
      // blind for the payer).
      ...(walletAddress ? { walletAddress } : {}),
    },
  });
  // Eagerly complete the referrer's INVITE milestone once this referee has
  // redeemed. Unconditional + idempotent (the QuestCompletion "once" unique key
  // no-ops after the first award), so we don't need a stored prior-state diff.
  if (deposited && appUser.referredById) {
    await evaluateMilestoneQuests(appUser.referredById);
  }
  // Return the LIVE eligibility (not the vestigial stored column) so every caller
  // — and the /sync API response — reflects the current redemption reality.
  return { ...appUser, hasDeposited: deposited };
}

/** Mask an email for display: "andini@gmail.com" → "and***@gmail.com". */
function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at);
  const shown = local.slice(0, Math.min(3, local.length));
  return `${shown}***${domain}`;
}

/** Referral tab data: code, this user's rate, earnings, joined friends, code-entry state. */
export async function getReferralInfo(appUserId: string) {
  const me = await prisma.appUser.findUnique({
    where: { id: appUserId },
    select: {
      referralCode: true,
      referredById: true,
      referralRateBps: true,
    },
  });
  // Live eligibility (count > 0), not a stored flag.
  const deposited = await hasRedeemed(appUserId);

  // One query: a friend is "qualified" once they have ≥1 CONFIRMED redemption.
  // Filtered relation _count keeps this a single round-trip (no per-friend N+1).
  const friends = await prisma.appUser.findMany({
    where: { referredById: appUserId },
    select: {
      id: true,
      email: true,
      createdAt: true,
      _count: { select: { redemptions: { where: { status: "CONFIRMED" } } } },
    },
    orderBy: { createdAt: "desc" },
  });

  // Earnings AS A REFERRER now come from referees' quest claims (refType
  // "referral_quest"). refId is the referee's QuestCompletion id, so map it back
  // to the friend to show a per-friend contribution.
  const earnings = await prisma.wpLedger.findMany({
    where: { appUserId, type: "REFERRAL_BONUS", refType: "referral_quest" },
    select: { refId: true, amount: true },
  });
  const referralWpEarned = earnings.reduce((sum, e) => sum + e.amount, 0);

  const completionIds = earnings
    .map((e) => e.refId)
    .filter((id): id is string => id != null);
  const completions = completionIds.length
    ? await prisma.questCompletion.findMany({
        where: { id: { in: completionIds } },
        select: { id: true, appUserId: true },
      })
    : [];
  const refereeByCompletion = new Map(completions.map((c) => [c.id, c.appUserId]));
  const wpByFriend = new Map<string, number>();
  for (const e of earnings) {
    const friendId = e.refId ? refereeByCompletion.get(e.refId) : undefined;
    if (friendId) wpByFriend.set(friendId, (wpByFriend.get(friendId) ?? 0) + e.amount);
  }

  const hasReferrer = me?.referredById != null;
  const ratePercent = (me?.referralRateBps ?? DEFAULT_REFERRAL_RATE_BPS) / 100;

  return {
    referralCode: me?.referralCode ?? null,
    // A user can attach a friend's code only if they haven't set one yet AND
    // haven't qualified yet.
    hasReferrer,
    canApplyCode: !hasReferrer && !deposited,
    // What THIS user earns as a referrer: a percentage of each friend's quest claims.
    ratePercent,
    stats: {
      friendsJoined: friends.length,
      referralWpEarned,
    },
    friends: friends.map((f) => ({
      label: maskEmail(f.email),
      joinedAt: f.createdAt,
      qualified: f._count.redemptions > 0,
      contributedWp: wpByFriend.get(f.id) ?? 0,
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
    select: { id: true, referredById: true },
  });
  if (!me) throw new ReferralCodeError("Pengguna tidak ditemukan");
  if (me.referredById) throw new ReferralCodeError("Kamu sudah memakai kode referral");
  // Eligibility is live now: a code can only be attached before the first redeem.
  // (Best-effort — a redeem landing between this check and the write could sneak
  // one in; this is a cosmetic-attribution path, not a money path, so no lock.)
  if (await hasRedeemed(appUserId))
    throw new ReferralCodeError("Kode referral hanya bisa dipakai sebelum deposit pertama");

  const referrerId = await resolveReferrerId(rawCode);
  if (!referrerId) throw new ReferralCodeError("Kode referral tidak valid");
  if (referrerId === appUserId)
    throw new ReferralCodeError("Tidak bisa memakai kode referral sendiri");

  // Atomic set-once on the referrer: only writes if the user still has no
  // referrer (closes the two-concurrent-applies race; a losing writer no-ops).
  const res = await prisma.appUser.updateMany({
    where: { id: appUserId, referredById: null },
    data: { referredById: referrerId },
  });
  if (res.count === 0)
    throw new ReferralCodeError("Kode referral sudah tidak bisa dipakai");
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

/**
 * The single source of truth for a user's redemption-derived state: the number
 * of THIS account's CONFIRMED on-chain redemptions, keyed by appUserId (not the
 * shared Privy email, so sybils don't share it). Everything derives from this
 * live count — eligibility to spend WP is `count > 0`, and the REDEEM milestone
 * ladder is the count itself. A refund flips a row out of CONFIRMED, so both drop
 * automatically with no flag to reset. (The AppUser.hasDeposited / qualifiedAt
 * columns are now vestigial — nothing reads them for gating.)
 */
export async function confirmedRedemptionCount(
  appUserId: string
): Promise<number> {
  return prisma.redemption.count({
    where: { appUserId, status: "CONFIRMED" },
  });
}

/** Convenience boolean: has this account redeemed on-chain at least once. */
export async function hasRedeemed(appUserId: string): Promise<boolean> {
  return (await confirmedRedemptionCount(appUserId)) > 0;
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

// The old flat two-sided referral payout (maybePayReferralBonuses) was removed in
// Wave 6: referral is now purely a real-time percentage of the referee's quest
// claims (see services/referral.ts). Historical "referral"/"referral_welcome"
// ledger rows are left untouched.
