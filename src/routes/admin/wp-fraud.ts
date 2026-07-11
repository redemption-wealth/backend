import { Hono } from "hono";
import { requireManager, type AuthEnv } from "../../middleware/auth.js";
import { topEarners, fastEarners } from "../../services/wpAdmin.js";

const adminWpFraud = new Hono<AuthEnv>();
adminWpFraud.use("*", requireManager);

// GET /api/admin/wp-fraud?limit= — top lifetime earners + fastest 24h earners.
adminWpFraud.get("/", async (c) => {
  const limit = parseInt(c.req.query("limit") ?? "10", 10);
  const [top, fast] = await Promise.all([
    topEarners(limit),
    fastEarners(limit),
  ]);
  return c.json({ topEarners: top, fastEarners: fast });
});

export default adminWpFraud;
