import { prisma } from "../db.js";
import { Prisma } from "@prisma/client";
import { createPublicClient, http } from "viem";
import { resolveChain } from "../lib/chain.js";
import { generateQrCode, generateUploadedAsset, deleteQrFiles } from "./qr-generator.js";
import { getWealthPrice } from "./price.js";
import type { VoucherFormat, BarcodeSymbology } from "./asset-values.js";

interface InitiateRedemptionParams {
  userEmail: string;
  voucherId: string;
  idempotencyKey: string;
  /** Trusted payer wallet from the Privy account (server-side). Preferred over
   * the app_users lookup, which is spoofable and often empty. */
  walletAddress?: string | null;
}

// Double-click / double-submit guard: while the user has an in-flight PENDING
// row (no txHash yet) for this voucher, a near-simultaneous redeem request
// REUSES that row instead of creating a second one. The client idempotencyKey
// can't catch this — each tap generates a fresh key.
//
// The window is SHORT (30s) on purpose: buying the same voucher again is a
// LEGITIMATE action (e.g. 2 event tickets), so it must NOT be shadowed. This
// only absorbs a true double-click / retry burst; the synchronous client guard
// blocks the common case, and a deliberate second purchase seconds later gets
// its own row. (A wider window here previously ate real repeat purchases.)
const PENDING_REUSE_WINDOW_MS = 30 * 1000;

function findRecentPendingRow(
  db: Pick<typeof prisma, "redemption">,
  userEmail: string,
  voucherId: string,
) {
  return db.redemption.findFirst({
    where: {
      userEmail,
      voucherId,
      status: "PENDING",
      txHash: null,
      createdAt: { gte: new Date(Date.now() - PENDING_REUSE_WINDOW_MS) },
    },
    orderBy: { createdAt: "desc" },
  });
}

export async function initiateRedemption({
  userEmail,
  voucherId,
  idempotencyKey,
  walletAddress: trustedWallet,
}: InitiateRedemptionParams) {
  // Check idempotency (scoped to user)
  const existing = await prisma.redemption.findFirst({
    where: { idempotencyKey, userEmail },
  });
  if (existing) {
    return { redemption: existing, alreadyExists: true };
  }

  // Fast-path double-submit check (raced taps are settled again under the
  // advisory lock inside the transaction below).
  const inFlight = await findRecentPendingRow(prisma, userEmail, voucherId);
  if (inFlight) {
    return { redemption: inFlight, alreadyExists: true };
  }

  // Fetch app settings for fees
  const settings = await prisma.appSettings.findUnique({
    where: { id: "singleton" },
  });
  const appFeePercentage = settings?.appFeeRate ?? new Prisma.Decimal(3);
  const gasFeeIdr = settings?.gasFeeAmount ?? new Prisma.Decimal(0);

  // Fetch WEALTH price server-side — must be outside $transaction to avoid holding DB connection during network call
  let priceIdr: number;
  try {
    const result = await getWealthPrice();
    priceIdr = result.priceIdr;
  } catch {
    throw new Error("Price service unavailable");
  }

  // Capture the payer wallet up-front so the webhook/sweep can match the
  // on-chain transfer back to this redemption even if the app never submits
  // the txHash (the 2026-07-16 lost-redemption case). PREFER the trusted
  // server-derived wallet (from the Privy account); only fall back to the
  // app_users lookup when it's absent. Best-effort — a missing wallet must not
  // block the redemption.
  let walletAddress: string | null = trustedWallet?.toLowerCase() ?? null;
  if (!walletAddress) {
    try {
      const appUser = await prisma.appUser.findFirst({
        where: { email: userEmail },
        select: { walletAddress: true },
      });
      walletAddress = appUser?.walletAddress?.toLowerCase() ?? null;
    } catch (err) {
      console.error("[initiateRedemption] wallet lookup failed:", err);
    }
  }

  // Reserve a slot in a transaction. QR codes are NOT touched here — they are
  // generated and handed to the user only once the on-chain transfer is
  // confirmed (see confirmRedemption). A failed/abandoned attempt therefore
  // leaves no QR and no history: the PENDING row is deleted on release.
  const result = await prisma.$transaction(async (tx) => {
    // Serialize per user+voucher: two raced double-click requests both pass the
    // fast-path check above; the lock makes the second one see (and reuse) the
    // row the first one created. Same advisory-lock pattern as the referral
    // bonus payout.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`redeem:${userEmail}:${voucherId}`}))`;
    const racedPending = await findRecentPendingRow(tx, userEmail, voucherId);
    if (racedPending) {
      return { row: racedPending, existed: true };
    }

    const voucher = await tx.voucher.findUnique({
      where: { id: voucherId },
      select: {
        id: true,
        remainingStock: true,
        isActive: true,
        startDate: true,
        expiryDate: true,
        basePrice: true,
        qrPerSlot: true,
        merchantId: true,
      },
    });

    if (!voucher) throw new Error("Voucher not found");
    if (!voucher.isActive) throw new Error("Voucher is not active");
    // Block redeeming "Akan Datang" vouchers before their start day (WIB).
    const startDay = new Date(voucher.startDate);
    startDay.setUTCHours(-7, 0, 0, 0); // 00:00 WIB = 17:00 UTC previous day
    if (startDay > new Date()) throw new Error("Voucher is not active yet");
    if (voucher.remainingStock <= 0) throw new Error("Voucher out of stock");
    // Voucher is valid through the entire expiry day in WIB (UTC+7)
    const expiryEnd = new Date(voucher.expiryDate);
    expiryEnd.setUTCHours(16, 59, 59, 999); // 23:59:59 WIB = 16:59:59 UTC
    if (expiryEnd < new Date()) throw new Error("Voucher expired");

    const qrPerRedemption = voucher.qrPerSlot;

    // Reserve an available slot. Only one redemption can claim a given slot, so
    // we cannot oversell even without an explicit FOR UPDATE.
    const availableSlot = await tx.redemptionSlot.findFirst({
      where: { voucherId, status: "AVAILABLE" },
      include: { qrCodes: { orderBy: { qrNumber: "asc" } } },
    });

    if (!availableSlot || availableSlot.qrCodes.length === 0) {
      throw new Error("No available QR codes in slots");
    }
    if (availableSlot.qrCodes.length !== qrPerRedemption) {
      throw new Error(
        `Slot has ${availableSlot.qrCodes.length} QR records but ${qrPerRedemption} were expected`,
      );
    }

    // 3-component pricing: base + app fee + gas fee
    const basePrice = new Prisma.Decimal(voucher.basePrice);
    const appFee = basePrice.mul(appFeePercentage).div(100);
    const gasFee = new Prisma.Decimal(gasFeeIdr.toString());
    const totalIdr = basePrice.add(appFee).add(gasFee);

    // priceIdr here is the WEALTH token price fetched from CMC (closure from above)
    const wealthPriceDecimal = new Prisma.Decimal(priceIdr);
    const wealthAmount = totalIdr.div(wealthPriceDecimal);
    const appFeeAmount = appFee.div(wealthPriceDecimal);
    const gasFeeAmount = gasFee.div(wealthPriceDecimal);

    const newRedemption = await tx.redemption.create({
      data: {
        userEmail,
        voucherId,
        merchantId: voucher.merchantId,
        slotId: availableSlot.id,
        wealthAmount,
        priceIdrAtRedeem: Math.round(Number(voucher.basePrice)),
        wealthPriceIdrAtRedeem: wealthPriceDecimal,
        appFeeAmount,
        gasFeeAmount,
        walletAddress,
        idempotencyKey,
        status: "PENDING",
      },
    });

    // Hold the slot. QR codes stay AVAILABLE until confirmation.
    await tx.redemptionSlot.update({
      where: { id: availableSlot.id },
      data: { status: "REDEEMED" },
    });

    return { row: newRedemption, existed: false };
  });

  return { redemption: result.row, alreadyExists: result.existed };
}

/**
 * Generate + assign the slot's QR codes to a CONFIRMED redemption. Idempotent:
 * deterministic R2 keys and an already-assigned check make it safe to call
 * repeatedly, so it doubles as a lazy-heal if QR generation failed right after
 * confirmation (e.g. R2 was briefly down).
 */
export async function ensureQrAssigned(redemptionId: string): Promise<void> {
  const redemption = await prisma.redemption.findUnique({
    where: { id: redemptionId },
    select: {
      status: true,
      voucher: {
        select: {
          format: true,
          assetSource: true,
          assetInputType: true,
          barcodeSymbology: true,
        },
      },
      slot: {
        select: {
          qrCodes: {
            select: { id: true, qrNumber: true, value: true, redemptionId: true },
            orderBy: { qrNumber: "asc" },
          },
        },
      },
    },
  });
  if (!redemption || redemption.status !== "CONFIRMED" || !redemption.slot) return;

  const qrRecords = redemption.slot.qrCodes;
  if (qrRecords.length === 0) return;
  if (qrRecords.every((q) => q.redemptionId === redemptionId)) return; // already assigned

  const now = new Date();

  if (
    redemption.voucher.assetSource === "MERCHANT_UPLOADED" &&
    redemption.voucher.assetInputType === "IMAGE"
  ) {
    // Pre-uploaded image files: the image is already stored on each row at
    // creation. Just hand it over (mark REDEEMED) — nothing is rendered.
    await prisma.$transaction(
      qrRecords.map((qr) =>
        prisma.qrCode.update({
          where: { id: qr.id },
          data: { status: "REDEEMED", redemptionId, assignedAt: now },
        }),
      ),
    );
    return;
  }

  if (redemption.voucher.assetSource === "MERCHANT_UPLOADED") {
    // Render each slot's pre-stored value (CODE → no image). The value is never
    // regenerated; only the rendered image + assignment metadata are written.
    const format = redemption.voucher.format as VoucherFormat;
    const symbology = redemption.voucher.barcodeSymbology as BarcodeSymbology | null;
    const rendered = await Promise.all(
      qrRecords.map((qr) =>
        generateUploadedAsset(redemptionId, qr.qrNumber, {
          format,
          value: qr.value ?? "",
          symbology,
        }),
      ),
    );
    await prisma.$transaction(
      qrRecords.map((qr, i) =>
        prisma.qrCode.update({
          where: { id: qr.id },
          data: {
            status: "REDEEMED",
            redemptionId,
            assignedAt: now,
            imageUrl: rendered[i].imageUrl, // null for CODE
            // imageHash is @unique NOT NULL — keep the placeholder for CODE.
            ...(rendered[i].imageHash ? { imageHash: rendered[i].imageHash } : {}),
          },
        }),
      ),
    );
    return;
  }

  // Wealth-generated flow (unchanged): mint a token + render a QR per record.
  // R2 uploads happen outside the DB transaction (network calls).
  const qrData = await Promise.all(
    qrRecords.map((qr) => generateQrCode(redemptionId, qr.qrNumber)),
  );
  await prisma.$transaction(
    qrRecords.map((qr, i) =>
      prisma.qrCode.update({
        where: { id: qr.id },
        data: {
          status: "REDEEMED",
          redemptionId,
          assignedAt: now,
          token: qrData[i].token,
          imageUrl: qrData[i].imageUrl,
          imageHash: qrData[i].imageHash,
        },
      }),
    ),
  );
}

export async function confirmRedemption(txHash: string) {
  // Claim the confirmation atomically — only one worker proceeds past this,
  // so a concurrent webhook + reconcile cannot double-assign QR codes.
  const target = await prisma.redemption.findFirst({
    where: { txHash, status: "PENDING" },
    select: { id: true, voucherId: true },
  });
  if (!target) throw new Error("Redemption not found or already processed");

  const claimed = await prisma.redemption.updateMany({
    where: { id: target.id, status: "PENDING" },
    data: { status: "CONFIRMED", confirmedAt: new Date() },
  });
  if (claimed.count === 0) {
    throw new Error("Redemption already confirmed by another worker");
  }

  // Transfer confirmed → generate + hand over the QR codes. If QR generation
  // fails (e.g. R2 briefly down) the confirmation still stands; the QR is
  // lazily healed on the next detail fetch via ensureQrAssigned.
  try {
    await ensureQrAssigned(target.id);
  } catch (err) {
    console.error("[confirmRedemption] QR assignment deferred:", err);
  }

  // Recalculate remainingStock from actual available slots.
  const availableCount = await prisma.redemptionSlot.count({
    where: { voucherId: target.voucherId, status: "AVAILABLE" },
  });
  await prisma.voucher.update({
    where: { id: target.voucherId },
    data: { remainingStock: availableCount },
  });

  return prisma.redemption.findUniqueOrThrow({ where: { id: target.id } });
}

let cachedRpcClient: ReturnType<typeof createPublicClient> | null = null;

function getRpcClient() {
  if (cachedRpcClient) return cachedRpcClient;
  const rpcUrl = process.env.ALCHEMY_RPC_URL;
  if (!rpcUrl) return null;
  const { chain } = resolveChain();
  cachedRpcClient = createPublicClient({ chain, transport: http(rpcUrl) });
  return cachedRpcClient;
}

export type ReconcileOutcome =
  | { reconciled: true; status: "CONFIRMED" | "FAILED" }
  | { reconciled: false; reason: "no-tx-hash" | "no-receipt" | "no-rpc" | "not-pending" };

export async function reconcileRedemptionById(
  redemptionId: string,
): Promise<ReconcileOutcome> {
  const redemption = await prisma.redemption.findUnique({
    where: { id: redemptionId },
    select: { id: true, status: true, txHash: true },
  });

  if (!redemption) throw new Error("Redemption not found");
  if (redemption.status !== "PENDING") {
    return { reconciled: false, reason: "not-pending" };
  }
  if (!redemption.txHash) {
    return { reconciled: false, reason: "no-tx-hash" };
  }

  const client = getRpcClient();
  if (!client) return { reconciled: false, reason: "no-rpc" };

  try {
    const receipt = await client.getTransactionReceipt({
      hash: redemption.txHash as `0x${string}`,
    });
    if (!receipt) return { reconciled: false, reason: "no-receipt" };

    if (receipt.status === "success") {
      await confirmRedemption(redemption.txHash);
      return { reconciled: true, status: "CONFIRMED" };
    }
    await failRedemption(redemption.txHash);
    return { reconciled: true, status: "FAILED" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/could not be found|not found/i.test(msg)) {
      return { reconciled: false, reason: "no-receipt" };
    }
    throw err;
  }
}

// A PENDING redemption is considered stale (the user never broadcast a tx)
// after this window. The user-facing banner escalates to "contact support" at
// 15 min; 30 min gives ample buffer before we release the slot back to stock.
export const STALE_PENDING_EXPIRY_MS = 30 * 60 * 1000;

/**
 * Release a PENDING redemption: free its reserved slot and KEEP the row as
 * honest history (product decision 2026-07-16 — records are never deleted, so
 * there is no data blindness; the 0x0b5f lost-redemption case was caused by
 * the old delete-on-release behavior).
 *
 * `outcome` sets the terminal status:
 *  - "EXPIRED" — abandoned before broadcast (chain verified empty / user quit)
 *  - "FAILED"  — the on-chain tx reverted
 * The row is detached from its slot (`slotId = NULL`) which frees the unique
 * constraint, so the slot can be reserved again — this preserves the fix for
 * the "Unique constraint failed on slotId" lockout.
 *
 * `deleteRow: true` keeps the old delete semantics for ONE case only: the user
 * explicitly cancelled before ever signing (nothing was paid, nothing to show).
 *
 * Guarded so a concurrent confirmation is never clobbered (only acts while
 * still PENDING). Returns true if it released the redemption.
 */
export async function releasePendingRedemption(
  redemptionId: string,
  opts?: { outcome?: "EXPIRED" | "FAILED"; deleteRow?: boolean },
): Promise<boolean> {
  const outcome = opts?.outcome ?? "EXPIRED";

  // Collect any assigned QR image keys up-front for best-effort R2 cleanup
  // (only transition-era pendings have these; new-flow pendings have none).
  const pre = await prisma.redemption.findUnique({
    where: { id: redemptionId },
    select: { status: true, qrCodes: { select: { imageUrl: true } } },
  });
  if (!pre || pre.status !== "PENDING") return false;
  const imageUrls = pre.qrCodes
    .map((q) => q.imageUrl)
    .filter(Boolean) as string[];

  const released = await prisma.$transaction(async (tx) => {
    // Read the slot/voucher we may need to clean up. This is NOT the guard —
    // the guard is the conditional write below.
    const current = await tx.redemption.findUnique({
      where: { id: redemptionId },
      select: { status: true, voucherId: true, slotId: true },
    });
    if (!current || current.status !== "PENDING") return false;

    // CLAIM-FIRST (fixes the TOCTOU): atomically flip the row out of PENDING
    // BEFORE touching QR/slot. A plain `update where:{id}` had no status
    // predicate, so a concurrent confirmRedemption committing between the
    // read above and the write could be clobbered CONFIRMED → EXPIRED (and its
    // QR reset). The guarded write below row-locks and only proceeds if WE are
    // the one taking the row out of PENDING; if a confirm already won, count is
    // 0 and we abort without resetting anything.
    let claimedCount: number;
    if (opts?.deleteRow) {
      // Explicit pre-broadcast user cancel — nothing was paid, leave no trace.
      const del = await tx.redemption.deleteMany({
        where: { id: redemptionId, status: "PENDING" },
      });
      claimedCount = del.count;
    } else {
      // Keep the record: mark terminal status + detach the slot so the unique
      // slotId is freed for the next redemption.
      const upd = await tx.redemption.updateMany({
        where: { id: redemptionId, status: "PENDING" },
        data: { status: outcome, failedAt: new Date(), slotId: null },
      });
      claimedCount = upd.count;
    }
    if (claimedCount !== 1) return false; // a concurrent confirm won — abort

    // We own the transition. Now clean up: detach any assigned QR codes back to
    // AVAILABLE (no-op in the normal flow, where a PENDING redemption has none).
    // NOTE: `value` is deliberately NOT reset — a merchant-uploaded value is
    // bound to its slot at creation and must survive release for reuse.
    await tx.qrCode.updateMany({
      where: { redemptionId },
      data: {
        status: "AVAILABLE",
        redemptionId: null,
        assignedAt: null,
        usedAt: null,
        scannedById: null,
        imageUrl: null,
      },
    });

    // Free the reserved slot.
    if (current.slotId) {
      await tx.redemptionSlot.updateMany({
        where: { id: current.slotId, status: "REDEEMED" },
        data: { status: "AVAILABLE" },
      });
    }

    const availableCount = await tx.redemptionSlot.count({
      where: { voucherId: current.voucherId, status: "AVAILABLE" },
    });
    await tx.voucher.update({
      where: { id: current.voucherId },
      data: { remainingStock: availableCount },
    });
    return true;
  });

  if (released && imageUrls.length > 0) {
    try {
      await deleteQrFiles(imageUrls);
    } catch (err) {
      console.error("[releasePendingRedemption] R2 cleanup failed:", err);
    }
  }
  return released;
}

/** The on-chain tx reverted — record the failure (row is kept as history). */
export async function failRedemption(txHash: string) {
  const redemption = await prisma.redemption.findFirst({
    where: { txHash, status: "PENDING" },
    select: { id: true },
  });
  if (!redemption) throw new Error("Redemption not found");
  return releasePendingRedemption(redemption.id, { outcome: "FAILED" });
}

// ─── On-chain safety check before any destructive action ────────────────────

interface TreasuryTransfer {
  txHash: string;
  amount: Prisma.Decimal;
}

/**
 * Ask the chain (Alchemy `alchemy_getAssetTransfers`) whether `walletAddress`
 * sent any $WEALTH to the treasury since `since`. Returns the transfers found.
 *
 * Throws when the answer cannot be determined (no RPC configured, RPC error) —
 * callers MUST treat a throw as "unknown" and take the NON-destructive path.
 */
export async function findTreasuryTransfersOnChain(
  walletAddress: string,
  since: Date,
): Promise<TreasuryTransfer[]> {
  const rpcUrl = process.env.ALCHEMY_RPC_URL;
  const treasury = process.env.DEV_WALLET_ADDRESS?.toLowerCase();
  const wealthContract = process.env.WEALTH_CONTRACT_ADDRESS?.toLowerCase();
  if (!rpcUrl || !treasury || !wealthContract) {
    throw new Error("On-chain check not configured (RPC/treasury/contract env missing)");
  }

  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "alchemy_getAssetTransfers",
      params: [
        {
          fromAddress: walletAddress,
          toAddress: treasury,
          contractAddresses: [wealthContract],
          category: ["erc20"],
          withMetadata: true,
          order: "desc",
          maxCount: "0x19", // 25 — ample for one wallet's recent activity
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`getAssetTransfers HTTP ${res.status}`);
  const json = (await res.json()) as {
    error?: { message?: string };
    result?: {
      transfers?: Array<{
        hash?: string;
        rawContract?: { value?: string; decimal?: string };
        metadata?: { blockTimestamp?: string };
      }>;
    };
  };
  if (json.error) throw new Error(`getAssetTransfers: ${json.error.message}`);

  const sinceMs = since.getTime();
  const out: TreasuryTransfer[] = [];
  for (const t of json.result?.transfers ?? []) {
    if (!t.hash) continue;
    const ts = t.metadata?.blockTimestamp
      ? Date.parse(t.metadata.blockTimestamp)
      : NaN;
    // 5-minute clock skew allowance: a transfer mined slightly "before" the
    // row's createdAt (server clock drift) must still count.
    if (Number.isFinite(ts) && ts < sinceMs - 5 * 60_000) continue;
    // Exact 18-dec amount from the raw hex value — activity.value is a float
    // and would lose precision.
    const rawHex = t.rawContract?.value;
    if (!rawHex) continue;
    const amount = new Prisma.Decimal(BigInt(rawHex).toString()).div(
      new Prisma.Decimal(10).pow(18),
    );
    out.push({ txHash: t.hash, amount });
  }
  return out;
}

/**
 * Sweep PENDING redemptions that never received a txHash and are older than
 * the stale window.
 *
 * SAFETY (2026-07-16): before releasing, the chain is consulted — if the
 * user's wallet DID send matching $WEALTH to the treasury (tx broadcast but
 * the app died before submitting the hash), the redemption is confirmed
 * instead of released. If the chain cannot be consulted (RPC down), the row
 * is left untouched: when in doubt, never destroy. This is the fix for the
 * lost-redemption case where money arrived but the record was deleted.
 *
 * Bounded by `limit` so a single invocation can't run unbounded; callers that
 * need to drain everything should loop until `expired < limit`.
 */
/**
 * Safely expire ONE stale PENDING-without-txHash redemption: consult the chain
 * first; recover (confirm) if the user actually paid; only expire when the
 * chain answers a clear "no transfer". Every caller that wants to release a
 * stale pending MUST go through this — never call releasePendingRedemption
 * directly for the stale-expiry case.
 */
type RecoverRow = {
  id: string;
  userEmail: string;
  walletAddress: string | null;
  wealthAmount: Prisma.Decimal;
  createdAt: Date;
};

/**
 * Chain-check the payer wallet for an unclaimed treasury payment matching
 * `row`, and recover it (adopt hash + confirm) — but ONLY when the match is
 * UNAMBIGUOUS. Single matcher shared by safeExpire and safeCancel so the
 * matching rules can't drift apart.
 *
 * Returns:
 *  - "recovered" — the row is now paid (or a concurrent worker claimed it);
 *    the caller must NOT expire/delete it.
 *  - "skipped"   — the chain could not be consulted (RPC down). Transient:
 *    the caller must KEEP the row PENDING and retry on the next sweep.
 *  - "none"      — no clean recovery: either the wallet is unknown (can't
 *    check — the webhook/sweep net still covers any real inflow), the chain
 *    has no matching transfer, or the match is AMBIGUOUS (>1 same-amount
 *    pending row → refuse to guess, leave it for the review queue). The caller
 *    may safely expire (never delete) the row.
 *
 * Ambiguity guard mirrors the webhook matcher's "exactly one candidate" rule —
 * the source of the cross-binding bug was that the safe paths lacked it.
 */
async function recoverPaymentFromChain(
  row: RecoverRow,
): Promise<"recovered" | "skipped" | "none"> {
  let wallet = row.walletAddress;
  if (!wallet) {
    const appUser = await prisma.appUser.findFirst({
      where: { email: row.userEmail },
      select: { walletAddress: true },
    });
    wallet = appUser?.walletAddress ?? null;
  }
  // Wallet unknown → cannot chain-check. Not "skipped" (that means transient):
  // this is persistent, so the caller should expire; a real inflow is still
  // caught by the webhook/sweep unmatched-transfers net.
  if (!wallet) return "none";

  let transfers: TreasuryTransfer[];
  try {
    transfers = await findTreasuryTransfersOnChain(
      wallet.toLowerCase(),
      row.createdAt,
    );
  } catch (err) {
    console.error(
      `[recoverPaymentFromChain] chain check failed for ${row.id} — keeping row:`,
      err,
    );
    return "skipped";
  }

  for (const t of transfers) {
    if (!t.amount.sub(row.wealthAmount).abs().lt(1e-9)) continue;
    const hashTaken = await prisma.redemption.findUnique({
      where: { txHash: t.txHash },
      select: { id: true },
    });
    if (hashTaken) continue;

    // Ambiguity guard: only adopt when exactly ONE of the user's PENDING rows
    // matches this amount. If several do, a single transfer can't be uniquely
    // attributed — refuse to guess and leave it for the webhook/sweep →
    // unmatched_transfers review queue (an admin resolves it).
    const pendings = await prisma.redemption.findMany({
      where: { userEmail: row.userEmail, status: "PENDING", txHash: null },
      select: { wealthAmount: true },
    });
    const sameAmount = pendings.filter((r) =>
      r.wealthAmount.sub(t.amount).abs().lt(1e-9),
    );
    if (sameAmount.length !== 1) {
      console.warn(
        `[recoverPaymentFromChain] AMBIGUOUS match for tx ${t.txHash} (${sameAmount.length} same-amount pendings) — leaving for review queue`,
      );
      return "none";
    }

    const claimed = await prisma.redemption.updateMany({
      where: { id: row.id, status: "PENDING", txHash: null },
      data: { txHash: t.txHash, walletAddress: wallet.toLowerCase() },
    });
    // count 0 = a concurrent worker already claimed this row; still "recovered"
    // from the caller's perspective (do not expire it).
    if (claimed.count === 0) return "recovered";
    try {
      await confirmRedemption(t.txHash);
    } catch (err) {
      console.error(
        `[recoverPaymentFromChain] recover-confirm deferred for ${row.id}:`,
        err,
      );
    }
    console.log(
      `[recoverPaymentFromChain] RECOVERED ${row.id} from on-chain tx ${t.txHash}`,
    );
    return "recovered";
  }
  return "none";
}

export async function safeExpireStalePending(
  redemptionId: string,
): Promise<"recovered" | "expired" | "skipped" | "noop"> {
  const redemption = await prisma.redemption.findUnique({
    where: { id: redemptionId },
    select: {
      id: true,
      status: true,
      txHash: true,
      userEmail: true,
      walletAddress: true,
      wealthAmount: true,
      createdAt: true,
    },
  });
  if (!redemption || redemption.status !== "PENDING" || redemption.txHash) {
    return "noop";
  }

  const outcome = await recoverPaymentFromChain(redemption);
  if (outcome === "recovered") return "recovered";
  if (outcome === "skipped") return "skipped"; // RPC down — keep, retry later

  // "none" → safe to expire (KEEP the row as history, never delete).
  const released = await releasePendingRedemption(redemption.id, {
    outcome: "EXPIRED",
  });
  return released ? "expired" : "noop";
}

/**
 * Safely cancel ONE pre-broadcast PENDING redemption (user-initiated cancel).
 *
 * The client's "nothing was broadcast" claim is EVIDENCE, not proof: Privy's
 * sendTransaction can throw after the tx was actually submitted (timeout /
 * network blip), which is exactly how the 0x5c18 redemption was lost on
 * 2026-07-17 — the old cancel DELETED the row while the money was in flight.
 * So this NEVER deletes. It asks the chain, then:
 *  - matching transfer found → adopt the hash + confirm ("recovered")
 *  - chain says no transfer  → mark EXPIRED and KEEP the row ("expired")
 *  - chain unknown (RPC down) → KEEP the row PENDING; the chain-checked sweep
 *    recover-or-expires it later ("kept"). When in doubt, never destroy.
 * A wallet-less row can't be chain-checked → it is EXPIRED (still kept); any
 * treasury inflow that lands afterwards is recorded by the webhook fallback +
 * inflow sweep, so the money is never lost.
 */
export async function safeCancelPendingRedemption(
  redemptionId: string,
): Promise<"expired" | "recovered" | "kept" | "noop"> {
  const redemption = await prisma.redemption.findUnique({
    where: { id: redemptionId },
    select: {
      id: true,
      status: true,
      txHash: true,
      userEmail: true,
      walletAddress: true,
      wealthAmount: true,
      createdAt: true,
    },
  });
  // Once a txHash exists the transfer is on-chain — leave it for
  // confirm/reconcile (mirrors the old route guard).
  if (!redemption || redemption.status !== "PENDING" || redemption.txHash) {
    return "noop";
  }

  const outcome = await recoverPaymentFromChain(redemption);
  if (outcome === "recovered") return "recovered";
  // RPC down — cannot prove non-payment right now. KEEP the row PENDING; the
  // chain-checked sweep settles it later. When in doubt, never destroy.
  if (outcome === "skipped") return "kept";

  // "none" → NEVER DELETE. A client "nothing was broadcast" claim is evidence,
  // not proof (Privy can throw after actually submitting — the 0x5c18 loss).
  // Mark EXPIRED and keep the row: if a payment was in flight and lands after
  // this, the webhook/sweep records it (auto-match or the review queue), so the
  // money is never lost and the row survives as correlation data. This is the
  // fix for the wallet-null population (app_users empty → the old `if(wallet)`
  // guard skipped the chain check entirely and deleted paid rows).
  const released = await releasePendingRedemption(redemption.id, {
    outcome: "EXPIRED",
  });
  return released ? "expired" : "noop";
}

export async function expireStalePendingRedemptions(opts?: {
  olderThanMs?: number;
  limit?: number;
}): Promise<{ expired: number; recovered: number; skipped: number; ids: string[] }> {
  const olderThanMs = opts?.olderThanMs ?? STALE_PENDING_EXPIRY_MS;
  const limit = opts?.limit ?? 100;
  const cutoff = new Date(Date.now() - olderThanMs);

  const stale = await prisma.redemption.findMany({
    where: { status: "PENDING", txHash: null, createdAt: { lt: cutoff } },
    select: { id: true },
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  const ids: string[] = [];
  let recovered = 0;
  let skipped = 0;

  for (const redemption of stale) {
    try {
      const result = await safeExpireStalePending(redemption.id);
      if (result === "expired") ids.push(redemption.id);
      else if (result === "recovered") recovered += 1;
      else if (result === "skipped") skipped += 1;
    } catch (err) {
      console.error(`[expireStalePendingRedemptions] ${redemption.id} failed:`, err);
    }
  }

  return { expired: ids.length, recovered, skipped, ids };
}
