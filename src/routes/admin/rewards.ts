import { Hono } from "hono";
import { prisma } from "../../db.js";
import { requireManager, type AuthEnv } from "../../middleware/auth.js";
import {
  createRewardSchema,
  updateRewardSchema,
  rewardAssetsSchema,
} from "../../schemas/wp-admin.js";
import { isNotFound } from "../../lib/prisma-errors.js";
import {
  addRewardAssets,
  listRewardAssets,
  deleteRewardAsset,
  RewardNotAvailableError,
} from "../../services/reward.js";

const adminRewards = new Hono<AuthEnv>();
adminRewards.use("*", requireManager);

adminRewards.get("/", async (c) => {
  const rewards = await prisma.wpReward.findMany({
    orderBy: [{ isActive: "desc" }, { wpCost: "asc" }],
  });
  // Attach live pool counts so the manager sees how many AUTO assets remain.
  const autoIds = rewards
    .filter((r) => r.fulfillmentType === "AUTO")
    .map((r) => r.id);
  const counts = autoIds.length
    ? await prisma.wpRewardAsset.groupBy({
        by: ["rewardId", "status"],
        where: { rewardId: { in: autoIds } },
        _count: { _all: true },
      })
    : [];
  const poolByReward = new Map<string, { available: number; assigned: number }>();
  for (const row of counts) {
    const cur = poolByReward.get(row.rewardId) ?? { available: 0, assigned: 0 };
    if (row.status === "AVAILABLE") cur.available = row._count._all;
    else if (row.status === "ASSIGNED") cur.assigned = row._count._all;
    poolByReward.set(row.rewardId, cur);
  }
  return c.json({
    rewards: rewards.map((r) => ({
      ...r,
      pool:
        r.fulfillmentType === "AUTO"
          ? poolByReward.get(r.id) ?? { available: 0, assigned: 0 }
          : null,
    })),
  });
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

// ─── Asset pool (AUTO rewards) ───────────────────────────────────────────────

// GET /api/admin/rewards/:id/assets — pool assets + available/assigned counts.
adminRewards.get("/:id/assets", async (c) => {
  const data = await listRewardAssets(c.req.param("id"));
  return c.json(data);
});

// POST /api/admin/rewards/:id/assets — bulk-add pool assets (codes/links/etc).
adminRewards.post("/:id/assets", async (c) => {
  const parsed = rewardAssetsSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
  }
  try {
    const result = await addRewardAssets(
      c.req.param("id"),
      parsed.data.kind,
      parsed.data.values
    );
    return c.json(result, 201);
  } catch (e) {
    if (e instanceof RewardNotAvailableError)
      return c.json({ error: "Reward tidak ditemukan" }, 404);
    throw e;
  }
});

// DELETE /api/admin/rewards/:id/assets/:assetId — remove a still-AVAILABLE asset.
adminRewards.delete("/:id/assets/:assetId", async (c) => {
  try {
    const result = await deleteRewardAsset(
      c.req.param("id"),
      c.req.param("assetId")
    );
    return c.json(result);
  } catch (e) {
    if (e instanceof RewardNotAvailableError)
      return c.json({ error: "Aset tidak bisa dihapus (sudah dipakai / tidak ada)" }, 404);
    throw e;
  }
});

export default adminRewards;
