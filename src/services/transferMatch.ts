import { Prisma } from "@prisma/client";
import { createPublicClient, http } from "viem";
import { prisma } from "../db.js";
import { resolveChain } from "../lib/chain.js";
import { confirmRedemption } from "./redemption.js";

const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
let cachedRpc: ReturnType<typeof createPublicClient> | null = null;
function rpc() {
  if (cachedRpc) return cachedRpc;
  const rpcUrl = process.env.ALCHEMY_RPC_URL;
  if (!rpcUrl) throw new Error("ALCHEMY_RPC_URL not configured");
  cachedRpc = createPublicClient({
    chain: resolveChain().chain,
    transport: http(rpcUrl),
  });
  return cachedRpc;
}

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

  // Who does this wallet belong to? Primary: the AppUser record. Fallback:
  // the wallet captured on any previous redemption — app_users.walletAddress
  // has proven unreliable (sync-before-wallet wiped it, 2026-07-17), while a
  // paid redemption is ground truth for wallet↔user ownership.
  let appUser = await prisma.appUser.findFirst({
    where: { walletAddress: { equals: fromAddress, mode: "insensitive" } },
    select: { email: true },
  });
  if (!appUser) {
    const priorRedemption = await prisma.redemption.findFirst({
      where: { walletAddress: { equals: fromAddress, mode: "insensitive" } },
      orderBy: { createdAt: "desc" },
      select: { userEmail: true },
    });
    if (priorRedemption) appUser = { email: priorRedemption.userEmail };
  }

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

/**
 * Pull-based safety net: scan ALL $WEALTH inflows into the treasury for the
 * recent window straight from the chain (alchemy_getAssetTransfers) and run
 * every hash the DB doesn't know through the hybrid matcher. Covers the case
 * where the push webhook was never delivered (or its fallback crashed) — the
 * 2026-07-17 0x5c18 inflow left NO trace in the DB despite the webhook net.
 * Idempotent: known hashes short-circuit as "already-known".
 */
export async function sweepTreasuryInflows(opts?: {
  sinceMs?: number;
}): Promise<{ scanned: number; alreadyKnown: number; autoConfirmed: number; queued: number }> {
  const sinceMs = opts?.sinceMs ?? 26 * 60 * 60 * 1000; // daily cron + 2h overlap
  const rpcUrl = process.env.ALCHEMY_RPC_URL;
  const treasury = process.env.DEV_WALLET_ADDRESS?.toLowerCase();
  const wealthContract = process.env.WEALTH_CONTRACT_ADDRESS?.toLowerCase();
  if (!rpcUrl || !treasury || !wealthContract) {
    throw new Error("Inflow sweep not configured (RPC/treasury/contract env missing)");
  }

  const cutoff = Date.now() - sinceMs;
  const counts = { scanned: 0, alreadyKnown: 0, autoConfirmed: 0, queued: 0 };
  // Paginate: 100/page is NOT "far above a day's volume" on a busy event day —
  // an unmatched inflow buried past page 1 would silently age out. Follow
  // Alchemy's pageKey until we cross the time cutoff or run out of pages.
  const MAX_PAGES = 20; // hard cap so a bug can't loop forever (2000 transfers)
  let pageKey: string | undefined;
  let reachedCutoff = false;

  for (let page = 0; page < MAX_PAGES && !reachedCutoff; page += 1) {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "alchemy_getAssetTransfers",
        params: [
          {
            toAddress: treasury,
            contractAddresses: [wealthContract],
            category: ["erc20"],
            withMetadata: true,
            order: "desc",
            maxCount: "0x64", // 100 per page
            ...(pageKey ? { pageKey } : {}),
          },
        ],
      }),
    });
    if (!res.ok) throw new Error(`getAssetTransfers HTTP ${res.status}`);
    const json = (await res.json()) as {
      error?: { message?: string };
      result?: {
        pageKey?: string;
        transfers?: Array<{
          hash?: string;
          from?: string;
          to?: string;
          rawContract?: { value?: string; address?: string };
          metadata?: { blockTimestamp?: string };
        }>;
      };
    };
    if (json.error) throw new Error(`getAssetTransfers: ${json.error.message}`);

    const transfers = json.result?.transfers ?? [];
    for (const t of transfers) {
      if (!t.hash || !t.from) continue;
      const ts = t.metadata?.blockTimestamp
        ? Date.parse(t.metadata.blockTimestamp)
        : NaN;
      // order:"desc" → once we see a transfer older than the window, every
      // subsequent one is older too. Stop paginating.
      if (Number.isFinite(ts) && ts < cutoff) {
        reachedCutoff = true;
        break;
      }
      const rawHex = t.rawContract?.value;
      if (!rawHex || !/^0x[0-9a-fA-F]+$/.test(rawHex)) continue;
      counts.scanned += 1;

      const amount = new Prisma.Decimal(BigInt(rawHex).toString()).div(
        new Prisma.Decimal(10).pow(18),
      );
      try {
        const outcome = await handleUnmatchedTreasuryTransfer({
          txHash: t.hash,
          fromAddress: t.from,
          toAddress: t.to ?? treasury,
          tokenAddress: t.rawContract?.address ?? wealthContract,
          amount,
        });
        if (outcome.outcome === "already-known") counts.alreadyKnown += 1;
        else if (outcome.outcome === "auto-confirmed") counts.autoConfirmed += 1;
        else counts.queued += 1;
      } catch (err) {
        // One bad transfer must not abort the sweep — the next run retries it.
        console.error(`[sweepTreasuryInflows] failed for tx ${t.hash}:`, err);
      }
    }

    pageKey = json.result?.pageKey;
    if (!pageKey) break; // no more pages
    if (page === MAX_PAGES - 1) {
      // Saturation: more pages exist than we scanned within the window. Alert —
      // an inflow could be beyond our reach. (Widen window / raise cap.)
      console.error(
        `[sweepTreasuryInflows] SATURATION: hit ${MAX_PAGES}-page cap with more pages remaining — an inflow may be unscanned`,
      );
    }
  }

  if (counts.autoConfirmed > 0 || counts.queued > 0) {
    console.warn(
      `[sweepTreasuryInflows] webhook missed inflows: auto-confirmed=${counts.autoConfirmed} queued=${counts.queued}`,
    );
  }
  return counts;
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

/**
 * A submit-tx 409 means the app reported a DIFFERENT hash than the one already
 * on the row — a genuine on-chain transfer (double-payment or a
 * rejected-but-broadcast retry) that would otherwise depend solely on the
 * webhook. Read its receipt, extract the $WEALTH→treasury transfer, and route
 * it through the hybrid matcher NOW (auto-confirm a lone candidate, else queue
 * to unmatched_transfers). Best-effort: the caller swallows throws — the
 * webhook + daily sweep remain the backstop.
 */
export async function recordRejectedTreasuryTx(txHash: string): Promise<void> {
  const treasury = process.env.DEV_WALLET_ADDRESS?.toLowerCase();
  const wealth = process.env.WEALTH_CONTRACT_ADDRESS?.toLowerCase();
  if (!treasury || !wealth) return;

  const receipt = await rpc().getTransactionReceipt({
    hash: txHash as `0x${string}`,
  });
  if (!receipt || receipt.status !== "success") return;

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== wealth) continue;
    if (log.topics[0] !== TRANSFER_TOPIC || log.topics.length < 3) continue;
    const from = `0x${log.topics[1]!.slice(-40)}`.toLowerCase();
    const to = `0x${log.topics[2]!.slice(-40)}`.toLowerCase();
    if (to !== treasury) continue;
    const amount = new Prisma.Decimal(BigInt(log.data).toString()).div(
      new Prisma.Decimal(10).pow(18),
    );
    await handleUnmatchedTreasuryTransfer({
      txHash: txHash.toLowerCase(),
      fromAddress: from,
      toAddress: to,
      tokenAddress: wealth,
      amount,
    });
    return;
  }
}
