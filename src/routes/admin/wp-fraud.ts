import { Hono } from "hono";
import { requireManager, type AuthEnv } from "../../middleware/auth.js";
import { getFraudReport, setFraudReviewStatus } from "../../services/wpAdmin.js";
import { fraudReviewSchema } from "../../schemas/wp-admin.js";

const adminWpFraud = new Hono<AuthEnv>();
adminWpFraud.use("*", requireManager);

// GET /api/admin/wp-fraud?limit= — enriched fraud signals.
// Returns top lifetime earners + fastest 24h earners, each row annotated with a
// heuristic `reason`, the user's manual `fraudReviewStatus`, WP-in-24h and
// lastActiveAt, plus `summary` numbers for the Figma summary cards.
adminWpFraud.get("/", async (c) => {
  const limit = parseInt(c.req.query("limit") ?? "10", 10);
  const report = await getFraudReport(limit);
  return c.json(report);
});

// PATCH /api/admin/wp-fraud/:appUserId/review — set the manual review label.
// Manual action only; NEVER blocks the user's earning or spending.
adminWpFraud.patch("/:appUserId/review", async (c) => {
  const parsed = fraudReviewSchema.safeParse(
    await c.req.json().catch(() => ({}))
  );
  if (!parsed.success) {
    return c.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      400
    );
  }
  const result = await setFraudReviewStatus(
    c.req.param("appUserId"),
    parsed.data.status
  );
  if (!result) return c.json({ error: "User tidak ditemukan" }, 404);
  return c.json(result);
});

export default adminWpFraud;
