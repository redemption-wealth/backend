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
}

export async function initiateRedemption({
  userEmail,
  voucherId,
  idempotencyKey,
}: InitiateRedemptionParams) {
  // Check idempotency (scoped to user)
  const existing = await prisma.redemption.findFirst({
    where: { idempotencyKey, userEmail },
  });
  if (existing) {
    return { redemption: existing, alreadyExists: true };
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
  // the txHash (the 2026-07-16 lost-redemption case). Best-effort: a missing
  // AppUser row must not block the redemption.
  let walletAddress: string | null = null;
  try {
    const appUser = await prisma.appUser.findFirst({
      where: { email: userEmail },
      select: { walletAddress: true },
    });
    walletAddress = appUser?.walletAddress?.toLowerCase() ?? null;
  } catch (err) {
    console.error("[initiateRedemption] wallet lookup failed:", err);
  }

  // Reserve a slot in a transaction. QR codes are NOT touched here — they are
  // generated and handed to the user only once the on-chain transfer is
  // confirmed (see confirmRedemption). A failed/abandoned attempt therefore
  // leaves no QR and no history: the PENDING row is deleted on release.
  const redemption = await prisma.$transaction(async (tx) => {
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

    return newRedemption;
  });

  return { redemption, alreadyExists: false };
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
  | {
      reconciled: false;
      reason:
        | "no-tx-hash"
        | "no-receipt"
        | "no-rpc"
        | "not-pending"
        | "not-a-payment";
    };

// ERC-20 Transfer(address,address,uint256) topic.
const RECONCILE_TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/**
 * A successful tx receipt is NOT proof of payment. Verify the receipt actually
 * contains a $WEALTH transfer INTO the treasury for `expectedAmount` — exactly
 * what the webhook validates. Without this, a user could submit ANY successful
 * txHash (someone else's transfer, any unrelated success) and reconcile would
 * confirm it → a free voucher (C1).
 */
function receiptPaysTreasury(
  receipt: { logs: ReadonlyArray<{ address: string; topics: string[]; data: string }> },
  expectedAmount: Prisma.Decimal,
): boolean {
  const treasury = process.env.DEV_WALLET_ADDRESS?.toLowerCase();
  const wealth = process.env.WEALTH_CONTRACT_ADDRESS?.toLowerCase();
  if (!treasury || !wealth) return false;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== wealth) continue;
    if (log.topics[0] !== RECONCILE_TRANSFER_TOPIC || log.topics.length < 3)
      continue;
    const to = `0x${log.topics[2]!.slice(-40)}`.toLowerCase();
    if (to !== treasury) continue;
    const amount = new Prisma.Decimal(BigInt(log.data).toString()).div(
      new Prisma.Decimal(10).pow(18),
    );
    if (amount.sub(expectedAmount).abs().lt(1e-9)) return true;
  }
  return false;
}

export async function reconcileRedemptionById(
  redemptionId: string,
): Promise<ReconcileOutcome> {
  const redemption = await prisma.redemption.findUnique({
    where: { id: redemptionId },
    select: { id: true, status: true, txHash: true, wealthAmount: true },
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
      // Only confirm if the receipt ACTUALLY pays the treasury the right amount
      // of $WEALTH — a bare "success" is not proof (C1 free-voucher fix).
      if (!receiptPaysTreasury(receipt, redemption.wealthAmount)) {
        console.warn(
          `[reconcile] tx ${redemption.txHash} succeeded but is NOT a $WEALTH→treasury payment of ${redemption.wealthAmount.toString()} — refusing to confirm ${redemption.id}`,
        );
        return { reconciled: false, reason: "not-a-payment" };
      }
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
    // Re-check inside the tx so we don't clobber a concurrent confirmation.
    const current = await tx.redemption.findUnique({
      where: { id: redemptionId },
      select: { status: true, voucherId: true, slotId: true },
    });
    if (!current || current.status !== "PENDING") return false;

    // Detach any assigned QR codes back to AVAILABLE (no-op in the normal flow,
    // where a PENDING redemption never has QR codes assigned). NOTE: `value` is
    // deliberately NOT reset — a merchant-uploaded value is bound to its slot at
    // creation and must survive release so the slot can be reused as-is.
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

    if (opts?.deleteRow) {
      // Explicit pre-broadcast user cancel — nothing was paid, leave no trace.
      await tx.redemption.delete({ where: { id: redemptionId } });
    } else {
      // Keep the record: mark terminal status + detach the slot so the unique
      // slotId is freed for the next redemption.
      await tx.redemption.update({
        where: { id: redemptionId },
        data: { status: outcome, failedAt: new Date(), slotId: null },
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

  // Resolve the payer wallet: stored on the row (new flow) or via AppUser.
  let wallet = redemption.walletAddress;
  if (!wallet) {
    const appUser = await prisma.appUser.findFirst({
      where: { email: redemption.userEmail },
      select: { walletAddress: true },
    });
    wallet = appUser?.walletAddress ?? null;
  }

  if (wallet) {
    // Ask the chain. A throw here means "unknown" → skip (fail-safe: when in
    // doubt, never destroy).
    let transfers: TreasuryTransfer[];
    try {
      transfers = await findTreasuryTransfersOnChain(
        wallet.toLowerCase(),
        redemption.createdAt,
      );
    } catch (err) {
      console.error(
        `[safeExpireStalePending] chain check failed for ${redemption.id} — keeping row:`,
        err,
      );
      return "skipped";
    }

    // A transfer matching this redemption's amount whose hash isn't already
    // claimed by another redemption → the user paid. Recover it.
    for (const t of transfers) {
      if (!t.amount.sub(redemption.wealthAmount).abs().lt(1e-9)) continue;
      const hashTaken = await prisma.redemption.findUnique({
        where: { txHash: t.txHash },
        select: { id: true },
      });
      if (hashTaken) continue;

      const claimed = await prisma.redemption.updateMany({
        where: { id: redemption.id, status: "PENDING", txHash: null },
        data: { txHash: t.txHash, walletAddress: wallet.toLowerCase() },
      });
      if (claimed.count === 0) return "noop"; // concurrent worker won
      try {
        await confirmRedemption(t.txHash);
      } catch (err) {
        // Hash is attached — the normal reconcile path finishes the job.
        console.error(
          `[safeExpireStalePending] recover-confirm deferred for ${redemption.id}:`,
          err,
        );
      }
      console.log(
        `[safeExpireStalePending] RECOVERED ${redemption.id} from on-chain tx ${t.txHash}`,
      );
      return "recovered";
    }
  }
  // Wallet unknown → we cannot check the chain for this row, but any treasury
  // inflow is still caught by the webhook's unmatched-transfers net, so
  // releasing cannot lose money silently.

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
