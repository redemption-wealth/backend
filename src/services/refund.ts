import { Prisma } from "@prisma/client";
import { createPublicClient, http } from "viem";
import { prisma } from "../db.js";
import { resolveChain } from "../lib/chain.js";
import { confirmRedemption } from "./redemption.js";

/**
 * Semi-manual refunds (decision 2026-07-16, full-total policy): an admin sends
 * $WEALTH back from the treasury by hand, then submits the refund txHash here.
 * The backend VERIFIES the refund on-chain — correct token, sent BY the
 * treasury, TO the payer wallet, for the FULL amount — before recording it.
 * Nothing is ever taken on faith.
 */

const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const AMOUNT_TOLERANCE = 1e-9;

let cachedClient: ReturnType<typeof createPublicClient> | null = null;
function getClient() {
  if (cachedClient) return cachedClient;
  const rpcUrl = process.env.ALCHEMY_RPC_URL;
  if (!rpcUrl) throw new Error("ALCHEMY_RPC_URL not configured");
  const { chain } = resolveChain();
  cachedClient = createPublicClient({ chain, transport: http(rpcUrl) });
  return cachedClient;
}

export interface VerifiedRefund {
  from: string;
  to: string;
  amount: Prisma.Decimal;
}

/**
 * Verify that `refundTxHash` is a successful on-chain $WEALTH transfer from
 * the treasury to `expectedTo` for `expectedAmount`. Throws with a specific
 * reason when any check fails.
 */
export async function verifyRefundOnChain(
  refundTxHash: string,
  expectedTo: string,
  expectedAmount: Prisma.Decimal,
): Promise<VerifiedRefund> {
  const treasury = process.env.DEV_WALLET_ADDRESS?.toLowerCase();
  const wealthContract = process.env.WEALTH_CONTRACT_ADDRESS?.toLowerCase();
  if (!treasury || !wealthContract) {
    throw new Error("Treasury/contract env not configured");
  }

  const receipt = await getClient().getTransactionReceipt({
    hash: refundTxHash as `0x${string}`,
  });
  if (!receipt) throw new Error("Refund tx not found on-chain");
  if (receipt.status !== "success") throw new Error("Refund tx reverted on-chain");

  const to = expectedTo.toLowerCase();
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== wealthContract) continue;
    if (log.topics[0] !== TRANSFER_TOPIC || log.topics.length < 3) continue;
    const logFrom = `0x${log.topics[1]!.slice(-40)}`.toLowerCase();
    const logTo = `0x${log.topics[2]!.slice(-40)}`.toLowerCase();
    if (logFrom !== treasury) continue;
    if (logTo !== to) continue;
    const amount = new Prisma.Decimal(BigInt(log.data).toString()).div(
      new Prisma.Decimal(10).pow(18),
    );
    if (!amount.sub(expectedAmount).abs().lt(AMOUNT_TOLERANCE)) {
      throw new Error(
        `Refund amount mismatch: on-chain ${amount.toString()}, expected ${expectedAmount.toString()}`,
      );
    }
    return { from: logFrom, to: logTo, amount };
  }
  throw new Error(
    "No $WEALTH transfer from the treasury to the payer wallet found in that tx",
  );
}

/**
 * Record a verified refund on a redemption (status → REFUNDED). Full-total
 * policy: the expected amount is `wealthAmount` — everything the user paid.
 * Frees the slot if one is still attached.
 */
export async function refundRedemption(
  redemptionId: string,
  refundTxHash: string,
  resolvedBy: string,
): Promise<{ redemptionId: string; refundTxHash: string }> {
  const redemption = await prisma.redemption.findUnique({
    where: { id: redemptionId },
    select: {
      id: true,
      status: true,
      txHash: true,
      walletAddress: true,
      userEmail: true,
      wealthAmount: true,
      voucherId: true,
      slotId: true,
    },
  });
  if (!redemption) throw new Error("Redemption not found");
  if (redemption.status === "REFUNDED") throw new Error("Already refunded");
  if (!redemption.txHash) {
    throw new Error("Redemption was never paid on-chain — nothing to refund");
  }

  // Destination: the wallet that paid. Stored on the row, or via AppUser.
  let payerWallet = redemption.walletAddress;
  if (!payerWallet) {
    const appUser = await prisma.appUser.findFirst({
      where: { email: redemption.userEmail },
      select: { walletAddress: true },
    });
    payerWallet = appUser?.walletAddress ?? null;
  }
  if (!payerWallet) {
    throw new Error("Payer wallet unknown — cannot verify refund destination");
  }

  const hash = refundTxHash.toLowerCase();
  await verifyRefundOnChain(hash, payerWallet, redemption.wealthAmount);

  await prisma.$transaction(async (tx) => {
    // Detach + free the slot and any assigned QR codes (refund = voucher not delivered).
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
    if (redemption.slotId) {
      await tx.redemptionSlot.updateMany({
        where: { id: redemption.slotId, status: { in: ["REDEEMED", "FULLY_USED"] } },
        data: { status: "AVAILABLE" },
      });
    }
    await tx.redemption.update({
      where: { id: redemptionId },
      data: {
        status: "REFUNDED",
        refundTxHash: hash,
        refundedAt: new Date(),
        slotId: null,
      },
    });
    const availableCount = await tx.redemptionSlot.count({
      where: { voucherId: redemption.voucherId, status: "AVAILABLE" },
    });
    await tx.voucher.update({
      where: { id: redemption.voucherId },
      data: { remainingStock: availableCount },
    });
  });

  console.log(
    `[refund] redemption ${redemptionId} REFUNDED via ${hash} by ${resolvedBy}`,
  );
  return { redemptionId, refundTxHash: hash };
}

/**
 * Resolve an unmatched transfer by pairing it with a PENDING redemption
 * (admin picked the right candidate) — adopts the hash and confirms through
 * the exact same path the webhook uses.
 */
export async function matchUnmatchedTransfer(
  unmatchedId: string,
  redemptionId: string,
  resolvedBy: string,
) {
  const row = await prisma.unmatchedTransfer.findUnique({
    where: { id: unmatchedId },
  });
  if (!row) throw new Error("Unmatched transfer not found");
  if (row.status !== "OPEN") throw new Error("Transfer already resolved");

  const redemption = await prisma.redemption.findUnique({
    where: { id: redemptionId },
    select: { id: true, status: true, txHash: true, wealthAmount: true },
  });
  if (!redemption) throw new Error("Redemption not found");
  if (redemption.status !== "PENDING" || redemption.txHash) {
    throw new Error("Redemption is not an open PENDING without txHash");
  }
  if (!redemption.wealthAmount.sub(row.amount).abs().lt(AMOUNT_TOLERANCE)) {
    throw new Error(
      `Amount mismatch: transfer ${row.amount.toString()}, redemption ${redemption.wealthAmount.toString()}`,
    );
  }

  const claimed = await prisma.redemption.updateMany({
    where: { id: redemptionId, status: "PENDING", txHash: null },
    data: { txHash: row.txHash, walletAddress: row.fromAddress },
  });
  if (claimed.count === 0) throw new Error("Redemption was claimed concurrently");

  try {
    await confirmRedemption(row.txHash);
  } catch (err) {
    console.error("[refund] match-confirm deferred:", err);
  }

  return prisma.unmatchedTransfer.update({
    where: { id: unmatchedId },
    data: {
      status: "MATCHED",
      matchedRedemptionId: redemptionId,
      resolvedBy,
      resolvedAt: new Date(),
    },
  });
}

/** Record a verified refund of an unmatched transfer (money sent back). */
export async function refundUnmatchedTransfer(
  unmatchedId: string,
  refundTxHash: string,
  resolvedBy: string,
  note?: string,
) {
  const row = await prisma.unmatchedTransfer.findUnique({
    where: { id: unmatchedId },
  });
  if (!row) throw new Error("Unmatched transfer not found");
  if (row.status !== "OPEN") throw new Error("Transfer already resolved");

  const hash = refundTxHash.toLowerCase();
  await verifyRefundOnChain(hash, row.fromAddress, row.amount);

  return prisma.unmatchedTransfer.update({
    where: { id: unmatchedId },
    data: {
      status: "REFUNDED",
      refundTxHash: hash,
      resolvedBy,
      resolvedAt: new Date(),
      ...(note ? { note } : {}),
    },
  });
}

/**
 * Manual fulfillment: the admin decided this inflow IS a purchase, but no
 * matching PENDING exists (user paid outside the app flow, or the order
 * expired long ago). Creates a fresh redemption for the chosen voucher —
 * priced by what was ACTUALLY paid — adopts the transfer's txHash, and
 * confirms through the normal path (QR assignment + stock). This is the
 * productized version of the 0x0b5f SQL recovery.
 */
export async function manualFulfillUnmatchedTransfer(
  unmatchedId: string,
  voucherId: string,
  userEmail: string,
  resolvedBy: string,
) {
  const row = await prisma.unmatchedTransfer.findUnique({
    where: { id: unmatchedId },
  });
  if (!row) throw new Error("Unmatched transfer not found");
  if (row.status !== "OPEN") throw new Error("Transfer already resolved");
  // Policy (2026-07-17): manual fulfillment ONLY for wallets linked to a known
  // account — a random wallet gets Refund/Ignore, never a voucher. The email
  // param must match the transfer's resolved account (defense in depth; the
  // UI pre-fills and locks it).
  if (!row.userEmail) {
    throw new Error(
      "Wallet is not linked to any user account — manual fulfillment is not allowed (use Refund/Ignore)",
    );
  }

  const email = userEmail.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("Valid userEmail is required");
  }
  if (email !== row.userEmail.toLowerCase()) {
    throw new Error("userEmail does not match the transfer's linked account");
  }

  const voucher = await prisma.voucher.findUnique({
    where: { id: voucherId },
    select: {
      id: true,
      title: true,
      merchantId: true,
      basePrice: true,
      qrPerSlot: true,
      isActive: true,
      deletedAt: true,
      appFeeSnapshot: true,
      gasFeeSnapshot: true,
    },
  });
  if (!voucher || voucher.deletedAt) throw new Error("Voucher not found");

  // Money fields derived from what the user actually paid on-chain — the
  // implied price keeps the record internally consistent (same construction
  // as the 0x0b5f recovery).
  const basePrice = new Prisma.Decimal(voucher.basePrice);
  const appFee = basePrice.mul(voucher.appFeeSnapshot).div(100);
  const gasFee = new Prisma.Decimal(voucher.gasFeeSnapshot);
  const totalIdr = basePrice.add(appFee).add(gasFee);
  const wealthPriceIdr = totalIdr.div(row.amount);

  const redemption = await prisma.$transaction(async (tx) => {
    const slot = await tx.redemptionSlot.findFirst({
      where: { voucherId: voucher.id, status: "AVAILABLE" },
      include: { qrCodes: { select: { id: true } } },
    });
    if (!slot) throw new Error("No available slot for this voucher (out of stock)");
    if (slot.qrCodes.length !== voucher.qrPerSlot) {
      throw new Error("Slot is missing its asset records — pick another voucher");
    }
    const claimed = await tx.redemptionSlot.updateMany({
      where: { id: slot.id, status: "AVAILABLE" },
      data: { status: "REDEEMED" },
    });
    if (claimed.count === 0) throw new Error("Slot was claimed concurrently — retry");

    return tx.redemption.create({
      data: {
        userEmail: email,
        voucherId: voucher.id,
        merchantId: voucher.merchantId,
        slotId: slot.id,
        wealthAmount: row.amount,
        priceIdrAtRedeem: Math.round(Number(voucher.basePrice)),
        wealthPriceIdrAtRedeem: wealthPriceIdr,
        appFeeAmount: appFee.div(wealthPriceIdr),
        gasFeeAmount: gasFee.div(wealthPriceIdr),
        walletAddress: row.fromAddress,
        txHash: row.txHash,
        idempotencyKey: `manual-fulfill-${row.txHash}`,
        status: "PENDING",
      },
    });
  });

  try {
    await confirmRedemption(row.txHash);
  } catch (err) {
    // Hash attached — reconcile/lazy-heal paths finish the confirmation.
    console.error("[refund] manual-fulfill confirm deferred:", err);
  }

  const updated = await prisma.unmatchedTransfer.update({
    where: { id: unmatchedId },
    data: {
      status: "MATCHED",
      matchedRedemptionId: redemption.id,
      userEmail: email,
      resolvedBy,
      resolvedAt: new Date(),
      note: `Manual fulfillment: voucher "${voucher.title}"`,
    },
  });

  console.log(
    `[refund] MANUAL-FULFILL ${unmatchedId} -> redemption ${redemption.id} (${email}) by ${resolvedBy}`,
  );
  return { transfer: updated, redemptionId: redemption.id };
}

/** Close an unmatched transfer without action (note required — audit trail). */
export async function ignoreUnmatchedTransfer(
  unmatchedId: string,
  resolvedBy: string,
  note: string,
) {
  const row = await prisma.unmatchedTransfer.findUnique({
    where: { id: unmatchedId },
  });
  if (!row) throw new Error("Unmatched transfer not found");
  if (row.status !== "OPEN") throw new Error("Transfer already resolved");
  if (!note.trim()) throw new Error("A note explaining WHY is required to ignore");

  return prisma.unmatchedTransfer.update({
    where: { id: unmatchedId },
    data: { status: "IGNORED", resolvedBy, resolvedAt: new Date(), note },
  });
}
