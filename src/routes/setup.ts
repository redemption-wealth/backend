import { Hono } from "hono";
import { prisma } from "../db.js";
import bcryptjs from "bcryptjs";

const setup = new Hono();

/**
 * ONE-TIME SETUP ENDPOINT
 *
 * POST /api/setup/init-owner
 *
 * IMPORTANT: Delete this endpoint after initial setup!
 * Only works if no owner exists yet (idempotent).
 */
setup.post("/init-owner", async (c) => {
  try {
    // Check if owner already exists
    const existingOwner = await prisma.admin.findFirst({
      where: { role: "owner" },
    });

    if (existingOwner) {
      return c.json(
        { error: "Owner already exists. Setup already completed." },
        400
      );
    }

    // Get credentials from request body
    const { email, password, setupKey } = await c.req.json();

    // Verify setup key (set this in environment variable)
    const expectedKey = process.env.SETUP_KEY;
    if (!expectedKey) {
      return c.json(
        { error: "Setup endpoint not configured. Set SETUP_KEY env variable." },
        500
      );
    }

    if (setupKey !== expectedKey) {
      return c.json({ error: "Invalid setup key" }, 401);
    }

    if (!email || !password) {
      return c.json({ error: "Email and password required" }, 400);
    }

    if (password.length < 8) {
      return c.json({ error: "Password must be at least 8 characters" }, 400);
    }

    // Create owner account
    const passwordHash = await bcryptjs.hash(password, 12);

    const owner = await prisma.admin.create({
      data: {
        email,
        passwordHash,
        role: "owner",
      },
    });

    // Create app settings if not exists
    await prisma.appSettings.upsert({
      where: { id: "singleton" },
      update: {},
      create: {
        id: "singleton",
        appFeeRate: 3,
        wealthContractAddress: process.env.WEALTH_CONTRACT_ADDRESS || "0x0000000000000000000000000000000000000000",
        devWalletAddress: process.env.DEV_WALLET_ADDRESS || "0x0000000000000000000000000000000000000000",
      },
    });

    // Create default fee setting
    const existingFee = await prisma.feeSetting.findFirst({
      where: { isActive: true },
    });

    if (!existingFee) {
      await prisma.feeSetting.create({
        data: {
          label: "Standard Gas Fee",
          amountIdr: 5000,
          isActive: true,
        },
      });
    }

    // Create categories
    const categories = [
      { name: "kuliner" },
      { name: "hiburan" },
      { name: "event" },
      { name: "kesehatan" },
      { name: "lifestyle" },
      { name: "travel" },
    ];

    for (const category of categories) {
      await prisma.category.upsert({
        where: { name: category.name },
        update: {},
        create: category,
      });
    }

    return c.json({
      success: true,
      message: "Owner account created successfully",
      owner: {
        id: owner.id,
        email: owner.email,
        role: owner.role,
      },
    });
  } catch (error) {
    console.error("[Setup] Error:", error);
    return c.json(
      { error: "Failed to initialize owner account" },
      500
    );
  }
});

export default setup;
