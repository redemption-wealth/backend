import { Hono } from "hono";
import { requireManager, type AuthEnv } from "../../middleware/auth.js";
import { conversionStatusSchema } from "../../schemas/wp-admin.js";
import {
  listConversions,
  fulfillConversion,
  rejectConversion,
  ConversionNotFoundError,
  ConversionNotPendingError,
} from "../../services/wpConversion.js";

const adminWpConversions = new Hono<AuthEnv>();
adminWpConversions.use("*", requireManager);

// GET /api/admin/wp-conversions?status=&limit=&offset=
adminWpConversions.get("/", async (c) => {
  const status = c.req.query("status") || undefined;
  const limit = parseInt(c.req.query("limit") ?? "50", 10);
  const offset = parseInt(c.req.query("offset") ?? "0", 10);
  const result = await listConversions({ status, limit, offset });
  return c.json(result);
});

// PATCH /api/admin/wp-conversions/:id — mark FULFILLED (records optional txHash)
// or REJECTED (refunds WP). The admin already sent the $WEALTH manually.
adminWpConversions.patch("/:id", async (c) => {
  const parsed = conversionStatusSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
  }
  const admin = c.get("adminAuth");
  const id = c.req.param("id");
  try {
    const conversion =
      parsed.data.status === "FULFILLED"
        ? await fulfillConversion(id, {
            txHash: parsed.data.txHash,
            note: parsed.data.note,
            fulfilledBy: admin.email,
          })
        : await rejectConversion(id, {
            note: parsed.data.note,
            fulfilledBy: admin.email,
          });
    return c.json({ conversion });
  } catch (e) {
    if (e instanceof ConversionNotFoundError)
      return c.json({ error: "Konversi tidak ditemukan" }, 404);
    if (e instanceof ConversionNotPendingError)
      return c.json({ error: e.message }, 409);
    throw e;
  }
});

export default adminWpConversions;
