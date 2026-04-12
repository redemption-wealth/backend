import { Hono } from "hono";
import { prisma } from "../../db.js";
import { requireOwner, type AuthEnv } from "../../middleware/auth.js";
import { updateSettingsSchema } from "../../schemas/settings.js";

const adminSettings = new Hono<AuthEnv>();

// GET /api/admin/settings — Get app settings
adminSettings.get("/", async (c) => {
  let settings = await prisma.appSettings.findUnique({
    where: { id: "singleton" },
  });

  if (!settings) {
    settings = await prisma.appSettings.create({
      data: { id: "singleton" },
    });
  }

  return c.json({ settings });
});

// PUT /api/admin/settings — Update app settings (owner only)
adminSettings.put("/", requireOwner, async (c) => {
  const body = await c.req.json();

  const parsed = updateSettingsSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      400
    );
  }

  const { appFeePercentage, tokenContractAddress, treasuryWalletAddress } =
    parsed.data;

  const settings = await prisma.appSettings.upsert({
    where: { id: "singleton" },
    update: {
      ...(appFeePercentage !== undefined && { appFeePercentage }),
      ...(tokenContractAddress !== undefined && { tokenContractAddress }),
      ...(treasuryWalletAddress !== undefined && { treasuryWalletAddress }),
    },
    create: {
      id: "singleton",
      appFeePercentage: appFeePercentage ?? 3,
      tokenContractAddress,
      treasuryWalletAddress,
    },
  });

  return c.json({ settings });
});

export default adminSettings;
