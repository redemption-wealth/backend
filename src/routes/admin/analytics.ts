import { Hono } from "hono";
import { requireOwner, type AuthEnv } from "../../middleware/auth.js";
import { getSummary, getRecentActivity } from "../../services/analytics.js";

const adminAnalytics = new Hono<AuthEnv>();

// All analytics require owner
adminAnalytics.use("/*", requireOwner);

// GET /api/admin/analytics/summary
adminAnalytics.get("/summary", async (c) => {
  const summary = await getSummary();
  return c.json(summary);
});

// GET /api/admin/analytics/recent-activity
adminAnalytics.get("/recent-activity", async (c) => {
  const limit = parseInt(c.req.query("limit") ?? "20");
  const activity = await getRecentActivity(limit);
  return c.json({ activity });
});

export default adminAnalytics;
