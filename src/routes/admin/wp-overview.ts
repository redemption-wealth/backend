import { Hono } from "hono";
import { requireManager, type AuthEnv } from "../../middleware/auth.js";
import { getOverview } from "../../services/wpAdmin.js";

const adminWpOverview = new Hono<AuthEnv>();
adminWpOverview.use("*", requireManager);

// GET /api/admin/wp-overview — KPI snapshot for the back-office WP Overview tab.
adminWpOverview.get("/", async (c) => {
  const overview = await getOverview();
  return c.json(overview);
});

export default adminWpOverview;
