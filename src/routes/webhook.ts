import { Hono } from "hono";
import { createHmac } from "crypto";
import {
  confirmRedemption,
  failRedemption,
} from "../services/redemption.js";

const webhook = new Hono();

/**
 * Verify Alchemy webhook signature using HMAC SHA256
 */
function verifyAlchemySignature(
  signature: string,
  body: string,
  signingKey: string
): boolean {
  const hmac = createHmac("sha256", signingKey);
  hmac.update(body);
  const expectedSignature = hmac.digest("hex");
  return signature === expectedSignature;
}

// POST /api/webhook/alchemy — Alchemy webhook for tx confirmation
webhook.post("/alchemy", async (c) => {
  // Get raw body for signature verification
  const bodyText = await c.req.text();

  // Verify Alchemy webhook signature
  const signature = c.req.header("x-alchemy-signature");
  if (!signature) {
    return c.json({ error: "Missing signature" }, 401);
  }

  const signingKey = process.env.ALCHEMY_WEBHOOK_SIGNING_KEY;
  if (!signingKey) {
    console.error("[Webhook] ALCHEMY_WEBHOOK_SIGNING_KEY not configured");
    return c.json({ error: "Webhook not configured" }, 500);
  }

  // Verify signature
  const isValid = verifyAlchemySignature(signature, bodyText, signingKey);
  if (!isValid) {
    console.warn("[Webhook] Invalid Alchemy signature");
    return c.json({ error: "Invalid signature" }, 401);
  }

  // Parse body after verification
  const body = JSON.parse(bodyText);
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
