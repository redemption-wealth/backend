import { createHmac, timingSafeEqual } from "crypto";
import { Hono } from "hono";
import { prisma } from "../db.js";
import { confirmRedemption } from "../services/redemption.js";
import {
  handleUnmatchedTreasuryTransfer,
  queueUnmatchedTransfer,
  parseActivityAmount,
} from "../services/transferMatch.js";
import { clearAnalyticsCache } from "../services/analytics.js";

const webhook = new Hono();

// POST /api/webhook/alchemy — Alchemy webhook for tx confirmation
webhook.post("/alchemy", async (c) => {
  // Must read raw body first — stream can only be consumed once
  const rawBody = await c.req.text();

  const signingKey = process.env.ALCHEMY_WEBHOOK_SIGNING_KEY;
  const isProduction = process.env.NODE_ENV === "production";

  if (!signingKey) {
    if (isProduction) {
      return c.json({ error: "Webhook not configured" }, 401);
    }
    console.warn("[webhook] ALCHEMY_WEBHOOK_SIGNING_KEY not set — skipping HMAC check in dev");
  } else {
    const signature = c.req.header("x-alchemy-signature");
    if (!signature) {
      return c.json({ error: "Missing signature" }, 401);
    }

    const computed = createHmac("sha256", signingKey).update(rawBody).digest("hex");
    const computedBuf = Buffer.from(computed, "hex");
    const sigBuf = Buffer.from(signature, "hex");

    if (computedBuf.length !== sigBuf.length || !timingSafeEqual(computedBuf, sigBuf)) {
      return c.json({ error: "Invalid signature" }, 401);
    }
  }

  const body = JSON.parse(rawBody);
  const { event } = body;

  if (!event?.activity) {
    return c.json({ error: "Invalid webhook payload" }, 400);
  }

  const wealthContract = process.env.WEALTH_CONTRACT_ADDRESS?.toLowerCase();
  const treasury = process.env.DEV_WALLET_ADDRESS?.toLowerCase();
  if (!wealthContract || !treasury) {
    console.warn(
      "[webhook] WEALTH_CONTRACT_ADDRESS / DEV_WALLET_ADDRESS not set — cannot validate transfers, skipping",
    );
  }

  for (const activity of event.activity) {
    const txHash = activity.hash;
    if (!txHash) continue;

    // Only a $WEALTH token transfer into the treasury confirms a redemption.
    // Alchemy omits typeTraceAddress for token transfers, so gating on it would
    // silently drop every confirmation — validate the asset and destination instead.
    if (activity.category !== "token") continue;
    if (!wealthContract || !treasury) continue;
    const tokenAddress = activity.rawContract?.address?.toLowerCase();
    const toAddress = activity.toAddress?.toLowerCase();
    if (tokenAddress !== wealthContract || toAddress !== treasury) continue;

    const amount = parseActivityAmount(activity);
    const transfer = {
      txHash,
      fromAddress: String(activity.fromAddress ?? ""),
      toAddress: String(activity.toAddress ?? ""),
      tokenAddress: String(activity.rawContract?.address ?? ""),
    };

    // Does a PENDING redemption already claim this hash (via submit-tx)?
    const claimed = await prisma.redemption.findFirst({
      where: { txHash, status: "PENDING" },
      select: { userEmail: true, wealthAmount: true, walletAddress: true },
    });

    if (claimed) {
      // R1 (round-5) — VERIFY the transfer actually pays this row before
      // confirming. `confirmRedemption` matches only {txHash,status:PENDING}
      // with NO amount/sender check, so without this an underpay (dust) tx
      // stamped onto a high-value row would confirm a full voucher.
      const from = transfer.fromAddress.toLowerCase();
      const amountMatches =
        amount != null && amount.sub(claimed.wealthAmount).abs().lt(1e-9);
      const senderMatches =
        !claimed.walletAddress || from === claimed.walletAddress.toLowerCase();

      if (amountMatches && senderMatches) {
        try {
          await confirmRedemption(txHash);
          clearAnalyticsCache();
        } catch (err) {
          console.error("[webhook] verified direct confirm failed:", err);
        }
      } else {
        // F1 (round-6) — the hash is on a PENDING row but the on-chain
        // amount/sender does NOT match it. Do NOT confirm (R1), but do NOT let
        // it strand silently either: `handleUnmatchedTreasuryTransfer` would
        // short-circuit on `already-known` (hash is on a redemption) and drop
        // it with no admin signal. Queue the inflow for manual review instead.
        console.warn(
          `[webhook] tx ${txHash} is on a PENDING row but amount/sender mismatch ` +
            `(paid ${amount?.toString() ?? "?"} from ${from}, expected ` +
            `${claimed.wealthAmount.toString()}` +
            `${claimed.walletAddress ? ` from ${claimed.walletAddress}` : ""}) — ` +
            `queuing for review (R1 reject + F1 no-silent-strand)`,
        );
        if (!amount) {
          console.error(`[webhook] cannot parse amount for tx ${txHash} — cannot queue mismatch`);
          continue;
        }
        try {
          await queueUnmatchedTransfer({
            ...transfer,
            amount,
            userEmail: claimed.userEmail,
          });
        } catch (queueErr) {
          console.error("[webhook] queue mismatched transfer failed:", queueErr);
        }
      }
      continue;
    }

    // No PENDING row claims this hash: unknown (app died before submit-tx) or
    // already confirmed (duplicate delivery). Run the hybrid fallback — exact
    // single candidate → auto-confirm; otherwise record the inflow in the
    // review queue. NO treasury inflow may ever be silently dropped (2026-07-16).
    try {
      if (!amount) {
        console.error(`[webhook] cannot parse amount for tx ${txHash} — skipping fallback`);
        continue;
      }
      const outcome = await handleUnmatchedTreasuryTransfer({ ...transfer, amount });
      if (outcome.outcome === "auto-confirmed") clearAnalyticsCache();
    } catch (fallbackErr) {
      console.error("[webhook] fallback match failed:", fallbackErr);
    }
  }

  return c.json({ ok: true });
});

export default webhook;
