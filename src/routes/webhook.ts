import { createHmac, timingSafeEqual } from "crypto";
import { Hono } from "hono";
import { confirmRedemption } from "../services/redemption.js";
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

    try {
      await confirmRedemption(txHash);
      clearAnalyticsCache();
    } catch (err) {
      // Unknown or already-confirmed txHash (e.g. a duplicate delivery) is
      // expected. A token-transfer event always means the transfer succeeded,
      // so there is no failure path to take here — log and continue.
      console.error("[webhook] confirmRedemption failed:", err);
    }
  }

  return c.json({ ok: true });
});

export default webhook;
