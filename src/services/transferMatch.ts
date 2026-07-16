import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { confirmRedemption } from "./redemption.js";

/**
 * Hybrid fallback matching for treasury inflows whose txHash is unknown to the
 * DB (decision 2026-07-16, docs/redemption-reliability-plan.md):
 *
 *  - Exactly ONE exact candidate (same user wallet, same amount, recent,
 *    PENDING without txHash) → adopt the hash + confirm automatically. The
 *    user gets their voucher in seconds even though the app never reported
 *    the hash (the 0x0b5f lost-redemption case).
 *  - ZERO or MULTIPLE candidates → record an `unmatched_transfers` row (OPEN)
 *    for the back-office review queue. NO incoming money may ever go
 *    unrecorded.
 *
 * Idempotent: re-delivery of the same transfer (webhook retries) is a no-op
 * thanks to the unique txHash on both tables.
 */

const CANDIDATE_WINDOW_MS = 24 * 60 * 60 * 1000;
// Decimal equality tolerance — both sides are exact 18-dec values, this only
// absorbs representation noise.
const AMOUNT_TOLERANCE = 1e-9;

export interface IncomingTransfer {
  txHash: string;
  fromAddress: string;
  toAddress: string;
  tokenAddress: string;
  /** Exact token amount (already divided by 10^decimals). */
  amount: Prisma.Decimal;
}

export type TransferMatchOutcome =
  | { outcome: "already-known" }
  | { outcome: "auto-confirmed"; redemptionId: string }
  | { outcome: "queued"; unmatchedTransferId: string; candidates: number };

export async function handleUnmatchedTreasuryTransfer(
  transfer: IncomingTransfer,
): Promise<TransferMatchOutcome> {
  const txHash = transfer.txHash.toLowerCase();
  const fromAddress = transfer.fromAddress.toLowerCase();

  // Idempotency: transfer already attached to a redemption or already queued.
  const [knownRedemption, knownUnmatched] = await Promise.all([
    prisma.redemption.findUnique({ where: { txHash }, select: { id: true } }),
    prisma.unmatchedTransfer.findUnique({
      where: { txHash },
      select: { id: true },
    }),
  ]);
  if (knownRedemption || knownUnmatched) return { outcome: "already-known" };

  // Who does this wallet belong to?
  const appUser = await prisma.appUser.findFirst({
    where: { walletAddress: { equals: fromAddress, mode: "insensitive" } },
    select: { email: true },
  });

  // Candidate redemptions: this user's recent PENDING rows that never got a
  // txHash, with the exact paid amount.
  let candidates: Array<{ id: string; wealthAmount: Prisma.Decimal }> = [];
  if (appUser) {
    const pendings = await prisma.redemption.findMany({
      where: {
        userEmail: appUser.email,
        status: "PENDING",
        txHash: null,
        createdAt: { gte: new Date(Date.now() - CANDIDATE_WINDOW_MS) },
      },
      select: { id: true, wealthAmount: true },
      orderBy: { createdAt: "asc" },
    });
    candidates = pendings.filter((r) =>
      r.wealthAmount.sub(transfer.amount).abs().lt(AMOUNT_TOLERANCE),
    );
  }

  if (candidates.length === 1) {
    // Exact single match → adopt the hash atomically and confirm.
    const claimed = await prisma.redemption.updateMany({
      where: { id: candidates[0].id, status: "PENDING", txHash: null },
      data: { txHash, walletAddress: fromAddress },
    });
    if (claimed.count === 1) {
      try {
        await confirmRedemption(txHash);
      } catch (err) {
        // Hash is attached — reconcile/lazy paths will finish confirmation.
        console.error("[transferMatch] auto-confirm deferred:", err);
      }
      console.log(
        `[transferMatch] AUTO-MATCHED tx ${txHash} -> redemption ${candidates[0].id}`,
      );
      return { outcome: "auto-confirmed", redemptionId: candidates[0].id };
    }
    // Lost the race — fall through to queue so the transfer is still recorded
    // unless the winner already attached this same hash.
    const nowKnown = await prisma.redemption.findUnique({
      where: { txHash },
      select: { id: true },
    });
    if (nowKnown) return { outcome: "already-known" };
  }

  // 0 or >1 candidates → review queue. Never drop an inflow on the floor.
  try {
    const row = await prisma.unmatchedTransfer.create({
      data: {
        txHash,
        fromAddress,
        toAddress: transfer.toAddress.toLowerCase(),
        tokenAddress: transfer.tokenAddress.toLowerCase(),
        amount: transfer.amount,
        userEmail: appUser?.email ?? null,
        status: "OPEN",
      },
    });
    console.warn(
      `[transferMatch] QUEUED unmatched transfer ${txHash} (user=${appUser?.email ?? "unknown"}, candidates=${candidates.length})`,
    );
    return {
      outcome: "queued",
      unmatchedTransferId: row.id,
      candidates: candidates.length,
    };
  } catch (err) {
    // Unique violation = concurrent delivery already queued it. Anything else
    // must propagate — silently swallowing would recreate data blindness.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      return { outcome: "already-known" };
    }
    throw err;
  }
}

/** Parse an exact token amount from an Alchemy activity entry. */
export function parseActivityAmount(activity: {
  value?: number;
  rawContract?: { rawValue?: string; decimals?: string };
}): Prisma.Decimal | null {
  const raw = activity.rawContract?.rawValue;
  if (raw && /^0x[0-9a-fA-F]+$/.test(raw)) {
    const decimalsHex = activity.rawContract?.decimals;
    const decimals =
      decimalsHex && /^0x[0-9a-fA-F]+$/.test(decimalsHex)
        ? Number(BigInt(decimalsHex))
        : 18;
    return new Prisma.Decimal(BigInt(raw).toString()).div(
      new Prisma.Decimal(10).pow(decimals),
    );
  }
  // Fallback: the float `value` field (precision-lossy, last resort).
  if (typeof activity.value === "number" && Number.isFinite(activity.value)) {
    return new Prisma.Decimal(activity.value.toString());
  }
  return null;
}
