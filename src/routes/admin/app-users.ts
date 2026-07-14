import { Hono } from "hono";
import { requireManager, type AuthEnv } from "../../middleware/auth.js";
import { wpAdjustSchema } from "../../schemas/wp-admin.js";
import { listAppUsers, getAppUserDetail } from "../../services/wpAdmin.js";
import { adminAdjust } from "../../services/wp.js";

const adminAppUsers = new Hono<AuthEnv>();
adminAppUsers.use("*", requireManager);

// GET /api/admin/app-users?search=&limit=&offset=
adminAppUsers.get("/", async (c) => {
  const search = c.req.query("search") || undefined;
  const limit = parseInt(c.req.query("limit") ?? "50", 10);
  const offset = parseInt(c.req.query("offset") ?? "0", 10);
  const result = await listAppUsers({ search, limit, offset });
  return c.json(result);
});

// GET /api/admin/app-users/:id — detail + WP ledger
adminAppUsers.get("/:id", async (c) => {
  const detail = await getAppUserDetail(c.req.param("id"));
  if (!detail) return c.json({ error: "User tidak ditemukan" }, 404);
  return c.json(detail);
});

// POST /api/admin/app-users/:id/wp-adjust — manual grant/clawback
adminAppUsers.post("/:id/wp-adjust", async (c) => {
  const parsed = wpAdjustSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
  }
  const admin = c.get("adminAuth");
  const note = parsed.data.note
    ? `${parsed.data.note} (by ${admin.email})`
    : `Adjust by ${admin.email}`;
  const result = await adminAdjust(c.req.param("id"), parsed.data.amount, note);
  return c.json(result);
});

export default adminAppUsers;
