import { Hono } from "hono";
import { requireManager, type AuthEnv } from "../../middleware/auth.js";
import { redemptionStatusSchema } from "../../schemas/wp-admin.js";
import {
  listWpRedemptions,
  fulfillRedemption,
  rejectRedemption,
  RewardNotAvailableError,
  RedemptionNotPendingError,
} from "../../services/reward.js";

const adminWpRedemptions = new Hono<AuthEnv>();
adminWpRedemptions.use("*", requireManager);

// GET /api/admin/wp-redemptions?status=&limit=&offset=
adminWpRedemptions.get("/", async (c) => {
  const status = c.req.query("status") || undefined;
  const limit = parseInt(c.req.query("limit") ?? "50", 10);
  const offset = parseInt(c.req.query("offset") ?? "0", 10);
  const result = await listWpRedemptions({ status, limit, offset });
  return c.json(result);
});

// PATCH /api/admin/wp-redemptions/:id — fulfill or reject (reject refunds WP).
adminWpRedemptions.patch("/:id", async (c) => {
  const parsed = redemptionStatusSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
  }
  const admin = c.get("adminAuth");
  const id = c.req.param("id");
  try {
    const redemption =
      parsed.data.status === "FULFILLED"
        ? await fulfillRedemption(id, admin.email, parsed.data.fulfillmentNote)
        : await rejectRedemption(id, admin.email, parsed.data.note);
    return c.json({ redemption });
  } catch (e) {
    if (e instanceof RewardNotAvailableError)
      return c.json({ error: "Penukaran tidak ditemukan" }, 404);
    if (e instanceof RedemptionNotPendingError)
      return c.json({ error: e.message }, 409);
    throw e;
  }
});

export default adminWpRedemptions;
