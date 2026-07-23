import type { Prisma } from "@prisma/client";
import { creditWithTx, WpCapExceededError } from "./wp.js";

// Default referral commission rate (basis points) when a referrer has no custom
// rate set. 1000 bps = 10%. Managers raise KOLs in the back-office.
export const DEFAULT_REFERRAL_RATE_BPS = 1000;

export interface ReferralQuestCreditInput {
  /** The referee who just earned a quest reward. */
  refereeId: string;
  /** The referee's referrer (AppUser.referredById), if any. */
  refereeReferredById: string | null;
  /** Anti-bot gate: the referrer earns nothing until the referee has deposited. */
  refereeHasDeposited: boolean;
  /** WP basis the percentage is taken from — the quest's base reward. */
  basisWp: number;
  /** Stable idempotency ref — the referee's QuestCompletion id for this claim. */
  sourceRefId: string;
}

/**
 * Credit the referrer a percentage of a quest reward their referee just earned.
 *
 * Runs in real time inside the referee's own claim transaction — an append-only
 * ledger insert, so it's cheap, exactly-once, and never blocks the referee. WP is
 * minted on top: the referee keeps their full reward.
 *
 * No-ops (returns 0, writes nothing) when: the referee has no referrer; the
 * referee hasn't deposited (blocks self-referral farming before any on-chain
 * cost); the referrer is fraud-flagged; the rounded bonus is 0; a duplicate for
 * this claim already exists; or the monthly issuance cap is hit. None of these
 * may roll back the referee's claim, so the cap error is swallowed here.
 *
 * Deadlock-free by design: unlike a spend, this takes NO advisory lock, so
 * nesting it inside the referee's already-locked claim can't deadlock.
 */
export async function creditReferrerForQuest(
  tx: Prisma.TransactionClient,
  input: ReferralQuestCreditInput,
): Promise<number> {
  const { refereeReferredById, refereeHasDeposited, basisWp, sourceRefId } = input;
  if (!refereeReferredById || !refereeHasDeposited) return 0;

  const referrer = await tx.appUser.findUnique({
    where: { id: refereeReferredById },
    select: { id: true, referralRateBps: true, fraudReviewStatus: true },
  });
  if (!referrer || referrer.fraudReviewStatus === "FLAGGED") return 0;

  const rateBps = referrer.referralRateBps ?? DEFAULT_REFERRAL_RATE_BPS;
  const amount = Math.floor((basisWp * rateBps) / 10_000);
  if (amount <= 0) return 0;

  // Idempotency: at most one referral credit per (referrer, source completion).
  const existing = await tx.wpLedger.findFirst({
    where: { appUserId: referrer.id, refType: "referral_quest", refId: sourceRefId },
    select: { id: true },
  });
  if (existing) return 0;

  try {
    await creditWithTx(tx, {
      appUserId: referrer.id,
      amount,
      type: "REFERRAL_BONUS",
      refType: "referral_quest",
      refId: sourceRefId,
      note: `Referral ${rateBps / 100}% dari quest teman`,
    });
  } catch (e) {
    // Cap reached → the referrer bonus lapses; must NOT fail the referee's claim.
    if (e instanceof WpCapExceededError) return 0;
    throw e;
  }
  return amount;
}
