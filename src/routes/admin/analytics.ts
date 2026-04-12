import { Hono } from "hono";
import { requireAdmin, type AuthEnv } from "../../middleware/auth.js";
import {
  getSummaryStats,
  getRedemptionsOverTime,
  getMerchantCategoryDistribution,
  getWealthVolumeOverTime,
  getTopMerchants,
  getTopVouchers,
} from "../../services/analytics.js";
import { prisma } from "../../db.js";

const adminAnalytics = new Hono<AuthEnv>();

// All analytics require admin or owner
adminAnalytics.use("/*", requireAdmin);

// GET /api/admin/analytics/summary
adminAnalytics.get("/summary", async (c) => {
  const summary = await getSummaryStats();
  return c.json({ summary });
});

// GET /api/admin/analytics/recent-activity
adminAnalytics.get("/recent-activity", async (c) => {
  const limit = Math.min(parseInt(c.req.query("limit") ?? "10"), 50);

  const activities = await prisma.redemption.findMany({
    where: { status: "confirmed" },
    include: {
      user: { select: { email: true } },
      voucher: {
        include: {
          merchant: { select: { name: true } },
        },
      },
    },
    orderBy: { confirmedAt: "desc" },
    take: limit,
  });

  return c.json({ activities });
});

// GET /api/admin/analytics/redemptions-over-time
adminAnalytics.get("/redemptions-over-time", async (c) => {
  const period = (c.req.query("period") || "daily") as
    | "daily"
    | "yearly"
    | "monthly";

  if (!["daily", "yearly", "monthly"].includes(period)) {
    return c.json({ error: "Invalid period. Use: daily, yearly, or monthly" }, 400);
  }

  const data = await getRedemptionsOverTime(period);
  return c.json({ data });
});

// GET /api/admin/analytics/merchant-categories
adminAnalytics.get("/merchant-categories", async (c) => {
  const data = await getMerchantCategoryDistribution();
  return c.json({ data });
});

// GET /api/admin/analytics/wealth-volume
adminAnalytics.get("/wealth-volume", async (c) => {
  const period = (c.req.query("period") || "monthly") as
    | "daily"
    | "yearly"
    | "monthly";

  if (!["daily", "yearly", "monthly"].includes(period)) {
    return c.json({ error: "Invalid period. Use: daily, yearly, or monthly" }, 400);
  }

  const data = await getWealthVolumeOverTime(period);
  return c.json({ data });
});

// GET /api/admin/analytics/top-merchants
adminAnalytics.get("/top-merchants", async (c) => {
  const limit = Math.min(parseInt(c.req.query("limit") ?? "3"), 10);
  const data = await getTopMerchants(limit);
  return c.json({ data });
});

// GET /api/admin/analytics/top-vouchers
adminAnalytics.get("/top-vouchers", async (c) => {
  const limit = Math.min(parseInt(c.req.query("limit") ?? "3"), 10);
  const data = await getTopVouchers(limit);
  return c.json({ data });
});

// GET /api/admin/analytics/treasury-balance (stub)
adminAnalytics.get("/treasury-balance", async (c) => {
  // Get treasury addresses from settings
  const settings = await prisma.appSettings.findUnique({
    where: { id: "singleton" },
    select: {
      tokenContractAddress: true,
      treasuryWalletAddress: true,
    },
  });

  if (!settings?.tokenContractAddress || !settings?.treasuryWalletAddress) {
    return c.json(
      {
        error: "Treasury addresses not configured. Please set tokenContractAddress and treasuryWalletAddress in settings",
      },
      400
    );
  }

  // Stub response - actual blockchain integration will be implemented later
  return c.json({
    balance: "0",
    tokenAddress: settings.tokenContractAddress,
    treasuryAddress: settings.treasuryWalletAddress,
    note: "Blockchain integration pending. Balance is currently a placeholder.",
  });
});

export default adminAnalytics;
