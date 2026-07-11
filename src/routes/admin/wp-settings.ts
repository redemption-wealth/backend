import { Hono } from "hono";
import { prisma } from "../../db.js";
import { requireManager, type AuthEnv } from "../../middleware/auth.js";
import { wpSettingsSchema } from "../../schemas/wp-admin.js";

const adminWpSettings = new Hono<AuthEnv>();
adminWpSettings.use("*", requireManager);

const DEFAULT_MONTHLY_CAP = 1_000_000;

// GET /api/admin/wp-settings — current WP cockpit settings (Wave 1: monthly cap).
adminWpSettings.get("/", async (c) => {
  const settings = await prisma.appSettings.findUnique({
    where: { id: "singleton" },
    select: { wpMonthlyCapWp: true },
  });
  return c.json({ wpMonthlyCapWp: settings?.wpMonthlyCapWp ?? DEFAULT_MONTHLY_CAP });
});

// PATCH /api/admin/wp-settings — update the monthly WP issuance cap.
adminWpSettings.patch("/", async (c) => {
  const parsed = wpSettingsSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
  }
  const settings = await prisma.appSettings.upsert({
    where: { id: "singleton" },
    update: { wpMonthlyCapWp: parsed.data.wpMonthlyCapWp },
    create: { id: "singleton", wpMonthlyCapWp: parsed.data.wpMonthlyCapWp },
  });
  return c.json({ wpMonthlyCapWp: settings.wpMonthlyCapWp });
});

export default adminWpSettings;
