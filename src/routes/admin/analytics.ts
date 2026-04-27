import { Hono } from "hono";
import { createPublicClient, http, erc20Abi, formatUnits } from "viem";
import { mainnet, sepolia } from "viem/chains";
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

adminAnalytics.use("/*", requireAdmin);

// GET /api/admin/analytics/summary
adminAnalytics.get("/summary", async (c) => {
  const adminAuth = c.get("adminAuth");
  const merchantId = adminAuth.role === "admin" ? adminAuth.merchantId : undefined;
  const summary = await getSummaryStats(merchantId);
  return c.json({ summary });
});

// GET /api/admin/analytics/recent-activity
adminAnalytics.get("/recent-activity", async (c) => {
  const adminAuth = c.get("adminAuth");
  const limit = Math.min(parseInt(c.req.query("limit") ?? "10"), 50);

  const activities = await prisma.redemption.findMany({
    where: {
      status: "confirmed",
      ...(adminAuth.role === "admin" && adminAuth.merchantId && {
        voucher: { merchantId: adminAuth.merchantId },
      }),
    },
    include: {
      user: { select: { email: true } },
      voucher: { include: { merchant: { select: { name: true } } } },
    },
    orderBy: { confirmedAt: "desc" },
    take: limit,
  });

  return c.json({ activities });
});

// GET /api/admin/analytics/redemptions-over-time
adminAnalytics.get("/redemptions-over-time", async (c) => {
  const adminAuth = c.get("adminAuth");
  const period = (c.req.query("period") || "daily") as "daily" | "yearly" | "monthly";

  if (!["daily", "yearly", "monthly"].includes(period)) {
    return c.json({ error: "Invalid period. Use: daily, yearly, or monthly" }, 400);
  }

  const merchantId = adminAuth.role === "admin" ? adminAuth.merchantId : undefined;
  const data = await getRedemptionsOverTime(period, merchantId);
  return c.json({ data });
});

// GET /api/admin/analytics/merchant-categories
adminAnalytics.get("/merchant-categories", async (c) => {
  const adminAuth = c.get("adminAuth");
  const merchantId = adminAuth.role === "admin" ? adminAuth.merchantId : undefined;
  const data = await getMerchantCategoryDistribution(merchantId);
  return c.json({ data });
});

// GET /api/admin/analytics/wealth-volume
adminAnalytics.get("/wealth-volume", async (c) => {
  const adminAuth = c.get("adminAuth");
  const period = (c.req.query("period") || "monthly") as "daily" | "yearly" | "monthly";

  if (!["daily", "yearly", "monthly"].includes(period)) {
    return c.json({ error: "Invalid period. Use: daily, yearly, or monthly" }, 400);
  }

  const merchantId = adminAuth.role === "admin" ? adminAuth.merchantId : undefined;
  const data = await getWealthVolumeOverTime(period, merchantId);
  return c.json({ data });
});

// GET /api/admin/analytics/top-merchants
adminAnalytics.get("/top-merchants", async (c) => {
  const adminAuth = c.get("adminAuth");
  const limit = Math.min(parseInt(c.req.query("limit") ?? "3"), 10);
  const merchantId = adminAuth.role === "admin" ? adminAuth.merchantId : undefined;
  const data = await getTopMerchants(limit, merchantId);
  return c.json({ data });
});

// GET /api/admin/analytics/top-vouchers
adminAnalytics.get("/top-vouchers", async (c) => {
  const adminAuth = c.get("adminAuth");
  const limit = Math.min(parseInt(c.req.query("limit") ?? "3"), 10);
  const merchantId = adminAuth.role === "admin" ? adminAuth.merchantId : undefined;
  const data = await getTopVouchers(limit, merchantId);
  return c.json({ data });
});

// GET /api/admin/analytics/treasury-balance
adminAnalytics.get("/treasury-balance", async (c) => {
  const settings = await prisma.appSettings.findUnique({
    where: { id: "singleton" },
    select: {
      wealthContractAddress: true,
      devWalletAddress: true,
    },
  });

  if (!settings?.wealthContractAddress || !settings?.devWalletAddress) {
    return c.json(
      { error: "Treasury addresses not configured. Please set wealthContractAddress and devWalletAddress in settings" },
      400
    );
  }

  const rpcUrl = process.env.ALCHEMY_RPC_URL;
  if (!rpcUrl) {
    return c.json({
      balance: "0",
      tokenAddress: settings.wealthContractAddress,
      treasuryAddress: settings.devWalletAddress,
      note: "ALCHEMY_RPC_URL not configured. Cannot read on-chain balance.",
    });
  }

  try {
    const chainId = Number(process.env.ETHEREUM_CHAIN_ID ?? 1);
    const chain = chainId === sepolia.id ? sepolia : mainnet;
    const client = createPublicClient({ chain, transport: http(rpcUrl) });

    const rawBalance = await client.readContract({
      address: settings.wealthContractAddress as `0x${string}`,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [settings.devWalletAddress as `0x${string}`],
    });

    const decimals = await client.readContract({
      address: settings.wealthContractAddress as `0x${string}`,
      abi: erc20Abi,
      functionName: "decimals",
    });

    const balance = formatUnits(rawBalance, decimals);

    return c.json({
      balance,
      tokenAddress: settings.wealthContractAddress,
      treasuryAddress: settings.devWalletAddress,
    });
  } catch (err) {
    console.error("[treasury-balance] Failed to read on-chain balance:", err);
    return c.json({
      balance: "0",
      tokenAddress: settings.wealthContractAddress,
      treasuryAddress: settings.devWalletAddress,
      note: "Failed to read on-chain balance.",
    });
  }
});

export default adminAnalytics;
