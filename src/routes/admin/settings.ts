import { Hono } from "hono";
import { prisma } from "../../db.js";
import { requireOwner, type AuthEnv } from "../../middleware/auth.js";
import { updateSettingsSchema } from "../../schemas/settings.js";

const adminSettings = new Hono<AuthEnv>();

// GET /api/admin/settings — Get app settings (owner only — exposes treasury wallet)
adminSettings.get("/", requireOwner, async (c) => {
  let settings = await prisma.appSettings.findUnique({
    where: { id: "singleton" },
  });

  if (!settings) {
    settings = await prisma.appSettings.create({
      data: { id: "singleton", updatedAt: new Date() },
    });
  }

  return c.json({ settings });
});

// PUT /api/admin/settings — Update app settings (owner only)
adminSettings.put("/", requireOwner, async (c) => {
  const adminAuth = c.get("adminAuth");
  const body = await c.req.json();

  const parsed = updateSettingsSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      400
    );
  }

  const { appFeeRate, wealthContractAddress, devWalletAddress, alchemyRpcUrl, coingeckoApiKey } =
    parsed.data;

  const updateData: Record<string, unknown> = {};
  if (appFeeRate !== undefined) {
    updateData.appFeeRate = appFeeRate;
    updateData.appFeeUpdatedBy = adminAuth.adminId;
    updateData.appFeeUpdatedAt = new Date();
  }
  if (wealthContractAddress !== undefined) updateData.wealthContractAddress = wealthContractAddress;
  if (devWalletAddress !== undefined) updateData.devWalletAddress = devWalletAddress;
  if (alchemyRpcUrl !== undefined) updateData.alchemyRpcUrl = alchemyRpcUrl;
  if (coingeckoApiKey !== undefined) updateData.coingeckoApiKey = coingeckoApiKey;

  const settings = await prisma.appSettings.upsert({
    where: { id: "singleton" },
    update: updateData,
    create: {
      id: "singleton",
      appFeeRate: appFeeRate ?? 3,
      wealthContractAddress,
      devWalletAddress,
      alchemyRpcUrl,
      coingeckoApiKey,
      updatedAt: new Date(),
    },
  });

  return c.json({ settings });
});

export default adminSettings;
