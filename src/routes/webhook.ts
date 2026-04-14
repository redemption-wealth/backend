import { Hono } from "hono";
import {
  confirmRedemption,
  failRedemption,
} from "../services/redemption.js";

const webhook = new Hono();

// POST /api/webhook/alchemy — Alchemy webhook for tx confirmation
webhook.post("/alchemy", async (c) => {
  // Verify Alchemy webhook signature
  const signature = c.req.header("x-alchemy-signature");
  if (!signature) {
    return c.json({ error: "Missing signature" }, 401);
  }

  // TODO: Verify signature with ALCHEMY_WEBHOOK_SIGNING_KEY
  // const body = await c.req.text();
  // const isValid = verifyAlchemySignature(signature, body, process.env.ALCHEMY_WEBHOOK_SIGNING_KEY);

  const body = await c.req.json();
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
