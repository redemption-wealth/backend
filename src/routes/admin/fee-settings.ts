import { Hono } from "hono";
import { prisma } from "../../db.js";
import { requireOwner, requireManager, type AuthEnv } from "../../middleware/auth.js";
import {
  createFeeSettingSchema,
  updateFeeSettingSchema,
} from "../../schemas/fee-setting.js";

const adminFeeSettings = new Hono<AuthEnv>();

// GET /api/admin/fee-settings — List all fee settings (any authenticated admin)
adminFeeSettings.get("/", async (c) => {
  const feeSettings = await prisma.feeSetting.findMany({
    orderBy: { createdAt: "desc" },
  });
  return c.json({ feeSettings });
});

// POST /api/admin/fee-settings — Create fee setting (manager+ only)
adminFeeSettings.post("/", requireManager, async (c) => {
  const body = await c.req.json();

  const parsed = createFeeSettingSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      400
    );
  }

  const feeSetting = await prisma.feeSetting.create({
    data: parsed.data,
  });

  return c.json({ feeSetting }, 201);
});

// PUT /api/admin/fee-settings/:id — Update fee setting (manager+ only)
adminFeeSettings.put("/:id", requireManager, async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();

  const parsed = updateFeeSettingSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      400
    );
  }

  try {
    const feeSetting = await prisma.feeSetting.update({
      where: { id },
      data: parsed.data,
    });
    return c.json({ feeSetting });
  } catch {
    return c.json({ error: "Fee setting not found" }, 404);
  }
});

// POST /api/admin/fee-settings/:id/activate — Activate fee (manager+ only)
adminFeeSettings.post("/:id/activate", requireManager, async (c) => {
  const id = c.req.param("id");

  const feeSetting = await prisma.feeSetting.findUnique({ where: { id } });
  if (!feeSetting) {
    return c.json({ error: "Fee setting not found" }, 404);
  }

  await prisma.$transaction([
    prisma.feeSetting.updateMany({
      where: { isActive: true },
      data: { isActive: false },
    }),
    prisma.feeSetting.update({
      where: { id },
      data: { isActive: true },
    }),
  ]);

  const updated = await prisma.feeSetting.findUnique({ where: { id } });
  return c.json({ feeSetting: updated });
});

// DELETE /api/admin/fee-settings/:id — Delete fee setting (manager+ only)
adminFeeSettings.delete("/:id", requireManager, async (c) => {
  const id = c.req.param("id");

  const feeSetting = await prisma.feeSetting.findUnique({ where: { id } });
  if (!feeSetting) {
    return c.json({ error: "Fee setting not found" }, 404);
  }

  if (feeSetting.isActive) {
    return c.json({ error: "Cannot delete the active fee setting" }, 400);
  }

  await prisma.feeSetting.delete({ where: { id } });
  return c.json({ ok: true });
});

export default adminFeeSettings;
