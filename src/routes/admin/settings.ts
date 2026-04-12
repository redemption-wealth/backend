import { Hono } from "hono";
import { prisma } from "../../db.js";
import { requireOwner, type AuthEnv } from "../../middleware/auth.js";

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
  const { devCutPercentage, tokenContractAddress, treasuryWalletAddress } =
    await c.req.json();

  const settings = await prisma.appSettings.upsert({
    where: { id: "singleton" },
    update: {
      ...(devCutPercentage !== undefined && { devCutPercentage }),
      ...(tokenContractAddress !== undefined && { tokenContractAddress }),
      ...(treasuryWalletAddress !== undefined && { treasuryWalletAddress }),
    },
    create: {
      id: "singleton",
      devCutPercentage: devCutPercentage ?? 3,
      tokenContractAddress,
      treasuryWalletAddress,
    },
  });

  return c.json({ settings });
});

export default adminSettings;
