import { createHmac, timingSafeEqual } from "crypto";
import { Hono } from "hono";
import { prisma } from "../db.js";
import { confirmRedemption } from "../services/redemption.js";
import {
  handleUnmatchedTreasuryTransfer,
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

    // R1 (round-5) — VERIFY the transfer actually pays the claimed redemption
    // before confirming. `confirmRedemption` matches only {txHash,status:PENDING}
    // with NO amount/sender check, so without this an underpay (dust) tx stamped
    // onto a high-value row via submit-tx would confirm a full voucher. Only
    // direct-confirm when the amount (and sender, when the row knows it) matches
    // the row this hash is attached to; anything else falls through to the
    // hybrid fallback (exact-candidate match or the unmatched-transfers review
    // queue) so a real inflow is still never dropped.
    let directConfirmed = false;
    const claimed = await prisma.redemption.findFirst({
      where: { txHash, status: "PENDING" },
      select: { wealthAmount: true, walletAddress: true },
    });
    if (claimed && amount) {
      const from = String(activity.fromAddress ?? "").toLowerCase();
      const amountMatches = amount.sub(claimed.wealthAmount).abs().lt(1e-9);
      const senderMatches =
        !claimed.walletAddress || from === claimed.walletAddress.toLowerCase();
      if (amountMatches && senderMatches) {
        try {
          await confirmRedemption(txHash);
          clearAnalyticsCache();
          directConfirmed = true;
        } catch (err) {
          console.error(
            "[webhook] verified direct confirm failed, running fallback:",
            err,
          );
        }
      } else {
        console.warn(
          `[webhook] tx ${txHash} is attached to a PENDING row but amount/sender do NOT match ` +
            `(paid ${amount.toString()} from ${from}, expected ${claimed.wealthAmount.toString()}` +
            `${claimed.walletAddress ? ` from ${claimed.walletAddress}` : ""}) — ` +
            `refusing direct confirm, routing to fallback (R1 underpay guard)`,
        );
      }
    }

    if (!directConfirmed) {
      // Unknown txHash (app died before submit-tx), already confirmed (duplicate
      // delivery), or amount/sender mismatch. Run the hybrid fallback: exact
      // single candidate → auto-confirm; otherwise record the inflow in the
      // unmatched-transfers review queue. NO treasury inflow may ever be
      // silently dropped (decision 2026-07-16).
      try {
        if (!amount) {
          console.error(`[webhook] cannot parse amount for tx ${txHash} — skipping fallback`);
          continue;
        }
        const outcome = await handleUnmatchedTreasuryTransfer({
          txHash,
          fromAddress: String(activity.fromAddress ?? ""),
          toAddress: String(activity.toAddress ?? ""),
          tokenAddress: String(activity.rawContract?.address ?? ""),
          amount,
        });
        if (outcome.outcome === "auto-confirmed") clearAnalyticsCache();
      } catch (fallbackErr) {
        console.error("[webhook] fallback match failed:", fallbackErr);
      }
    }
  }

  return c.json({ ok: true });
});

export default webhook;
