import { createHmac, timingSafeEqual } from "crypto";
import { Hono } from "hono";
import {
  confirmRedemption,
  failRedemption,
} from "../services/redemption.js";

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

  for (const activity of event.activity) {
    const txHash = activity.hash;
    if (!txHash) continue;

    try {
      if (
        activity.category === "token" &&
        activity.typeTraceAddress === "CALL"
      ) {
        await confirmRedemption(txHash);
      }
    } catch {
      try {
        await failRedemption(txHash);
      } catch {
        // Redemption may not exist for this txHash
      }
    }
  }

  return c.json({ ok: true });
});

export default webhook;
