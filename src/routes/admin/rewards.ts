import { Hono } from "hono";
import { prisma } from "../../db.js";
import { requireManager, type AuthEnv } from "../../middleware/auth.js";
import { createRewardSchema, updateRewardSchema } from "../../schemas/wp-admin.js";
import { isNotFound } from "../../lib/prisma-errors.js";

const adminRewards = new Hono<AuthEnv>();
adminRewards.use("*", requireManager);

adminRewards.get("/", async (c) => {
  const rewards = await prisma.wpReward.findMany({
    orderBy: [{ isActive: "desc" }, { wpCost: "asc" }],
  });
  return c.json({ rewards });
});

adminRewards.post("/", async (c) => {
  const parsed = createRewardSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
  }
  const { imageUrl, ...rest } = parsed.data;
  const reward = await prisma.wpReward.create({
    data: { ...rest, imageUrl: imageUrl || null },
  });
  return c.json({ reward }, 201);
});

adminRewards.patch("/:id", async (c) => {
  const parsed = updateRewardSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
  }
  const data: Record<string, unknown> = { ...parsed.data };
  if (data.imageUrl === "") data.imageUrl = null;
  try {
    const reward = await prisma.wpReward.update({
      where: { id: c.req.param("id") },
      data,
    });
    return c.json({ reward });
  } catch (e) {
    if (isNotFound(e)) return c.json({ error: "Reward tidak ditemukan" }, 404);
    throw e;
  }
});

export default adminRewards;
