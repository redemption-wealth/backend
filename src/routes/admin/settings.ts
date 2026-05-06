import { Hono } from "hono";
import { prisma } from "../../db.js";
import { requireManager, type AuthEnv } from "../../middleware/auth.js";
import { updateSettingsSchema } from "../../schemas/settings.js";

const adminSettings = new Hono<AuthEnv>();

// GET /api/admin/settings — Get app settings (owner only)
adminSettings.get("/", requireManager, async (c) => {
  let settings = await prisma.appSettings.findUnique({ where: { id: "singleton" } });

  if (!settings) {
    settings = await prisma.appSettings.create({
      data: { id: "singleton", updatedAt: new Date() },
    });
  }

  return c.json({ settings });
});

// PUT /api/admin/settings — Update app settings (owner only)
adminSettings.put("/", requireManager, async (c) => {
  const body = await c.req.json();

  const parsed = updateSettingsSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
  }

  const updateData: Record<string, unknown> = {};
  if (parsed.data.appFeeRate !== undefined) updateData.appFeeRate = parsed.data.appFeeRate;
  if (parsed.data.gasFeeAmount !== undefined) updateData.gasFeeAmount = parsed.data.gasFeeAmount;

  const settings = await prisma.appSettings.upsert({
    where: { id: "singleton" },
    update: updateData,
    create: {
      id: "singleton",
      appFeeRate: parsed.data.appFeeRate ?? 3,
      gasFeeAmount: parsed.data.gasFeeAmount ?? 0,
    },
  });

  return c.json({ settings });
});

export default adminSettings;
