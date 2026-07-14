import { Hono } from "hono";
import { prisma } from "../../db.js";
import { requireManager, type AuthEnv } from "../../middleware/auth.js";
import { createQuestSchema, updateQuestSchema } from "../../schemas/wp-admin.js";
import { isUniqueViolation, isNotFound } from "../../lib/prisma-errors.js";

const adminQuests = new Hono<AuthEnv>();
adminQuests.use("*", requireManager);

adminQuests.get("/", async (c) => {
  const quests = await prisma.quest.findMany({
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
  return c.json({ quests });
});

adminQuests.post("/", async (c) => {
  const parsed = createQuestSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
  }
  const { actionUrl, ...rest } = parsed.data;
  try {
    const quest = await prisma.quest.create({
      data: { ...rest, actionUrl: actionUrl || null },
    });
    return c.json({ quest }, 201);
  } catch (e) {
    if (isUniqueViolation(e)) return c.json({ error: "Key sudah dipakai" }, 409);
    throw e;
  }
});

adminQuests.patch("/:id", async (c) => {
  const parsed = updateQuestSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
  }
  const data: Record<string, unknown> = { ...parsed.data };
  if (data.actionUrl === "") data.actionUrl = null;
  try {
    const quest = await prisma.quest.update({
      where: { id: c.req.param("id") },
      data,
    });
    return c.json({ quest });
  } catch (e) {
    if (isNotFound(e)) return c.json({ error: "Quest tidak ditemukan" }, 404);
    if (isUniqueViolation(e)) return c.json({ error: "Key sudah dipakai" }, 409);
    throw e;
  }
});

adminQuests.delete("/:id", async (c) => {
  try {
    await prisma.quest.delete({ where: { id: c.req.param("id") } });
    return c.json({ ok: true });
  } catch (e) {
    if (isNotFound(e)) return c.json({ error: "Quest tidak ditemukan" }, 404);
    throw e;
  }
});

export default adminQuests;
