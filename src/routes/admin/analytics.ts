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

const adminAnalytics = new Hono<AuthEnv>();

type TreasuryCache = {
  balance: string;
  tokenAddress: string;
  treasuryAddress: string;
  cachedAt: number;
};
let treasuryCache: TreasuryCache | null = null;
const TREASURY_CACHE_TTL = 60_000;

adminAnalytics.use("/*", requireAdmin);

// GET /api/admin/analytics/summary
adminAnalytics.get("/summary", async (c) => {
  const adminAuth = c.get("adminAuth");
  const merchantId = adminAuth.role === "ADMIN" ? adminAuth.merchantId : undefined;
  const summary = await getSummaryStats(merchantId);
  return c.json({ summary });
});

// GET /api/admin/analytics/redemptions-over-time
adminAnalytics.get("/redemptions-over-time", async (c) => {
  const adminAuth = c.get("adminAuth");
  const period = (c.req.query("period") || "daily") as "daily" | "yearly" | "monthly";

  if (!["daily", "yearly", "monthly"].includes(period)) {
    return c.json({ error: "Invalid period. Use: daily, yearly, or monthly" }, 400);
  }

  const merchantId = adminAuth.role === "ADMIN" ? adminAuth.merchantId : undefined;
  const data = await getRedemptionsOverTime(period, merchantId);
  return c.json({ data });
});

// GET /api/admin/analytics/merchant-categories
adminAnalytics.get("/merchant-categories", async (c) => {
  const adminAuth = c.get("adminAuth");
  const merchantId = adminAuth.role === "ADMIN" ? adminAuth.merchantId : undefined;
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

  const merchantId = adminAuth.role === "ADMIN" ? adminAuth.merchantId : undefined;
  const data = await getWealthVolumeOverTime(period, merchantId);
  return c.json({ data });
});

// GET /api/admin/analytics/top-merchants
adminAnalytics.get("/top-merchants", async (c) => {
  const adminAuth = c.get("adminAuth");
  const limit = Math.min(parseInt(c.req.query("limit") ?? "3"), 10);
  const merchantId = adminAuth.role === "ADMIN" ? adminAuth.merchantId : undefined;
  const data = await getTopMerchants(limit, merchantId);
  return c.json({ data });
});

// GET /api/admin/analytics/top-vouchers
adminAnalytics.get("/top-vouchers", async (c) => {
  const adminAuth = c.get("adminAuth");
  const limit = Math.min(parseInt(c.req.query("limit") ?? "3"), 10);
  const merchantId = adminAuth.role === "ADMIN" ? adminAuth.merchantId : undefined;
  const data = await getTopVouchers(limit, merchantId);
  return c.json({ data });
});

// GET /api/admin/analytics/treasury-balance
adminAnalytics.get("/treasury-balance", async (c) => {
  const wealthContractAddress = process.env.WEALTH_CONTRACT_ADDRESS;
  const devWalletAddress = process.env.DEV_WALLET_ADDRESS;

  if (!wealthContractAddress || !devWalletAddress) {
    return c.json(
      { error: "Treasury addresses not configured. Set WEALTH_CONTRACT_ADDRESS and DEV_WALLET_ADDRESS env vars." },
      400
    );
  }

  // Cache hit
  if (treasuryCache && Date.now() - treasuryCache.cachedAt < TREASURY_CACHE_TTL) {
    return c.json(treasuryCache);
  }

  const rpcUrl = process.env.ALCHEMY_RPC_URL;
  if (!rpcUrl) {
    return c.json({
      balance: "0",
      tokenAddress: wealthContractAddress,
      treasuryAddress: devWalletAddress,
      note: "ALCHEMY_RPC_URL not configured. Cannot read on-chain balance.",
    });
  }

  try {
    const chainId = Number(process.env.ETHEREUM_CHAIN_ID ?? 1);
    const chain = chainId === sepolia.id ? sepolia : mainnet;
    const client = createPublicClient({ chain, transport: http(rpcUrl) });

    const rawBalance = await client.readContract({
      address: wealthContractAddress as `0x${string}`,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [devWalletAddress as `0x${string}`],
    });

    const decimals = await client.readContract({
      address: wealthContractAddress as `0x${string}`,
      abi: erc20Abi,
      functionName: "decimals",
    });

    const balance = formatUnits(rawBalance, decimals);

    treasuryCache = { balance, tokenAddress: wealthContractAddress, treasuryAddress: devWalletAddress, cachedAt: Date.now() };
    return c.json({ balance, tokenAddress: wealthContractAddress, treasuryAddress: devWalletAddress });
  } catch (err) {
    console.error("[treasury-balance] Failed to read on-chain balance:", err);

    // Return stale cache on RPC failure
    if (treasuryCache) {
      return c.json({ ...treasuryCache, stale: true });
    }
    return c.json({
      balance: "0",
      tokenAddress: wealthContractAddress,
      treasuryAddress: devWalletAddress,
      note: "Failed to read on-chain balance.",
    });
  }
});

export default adminAnalytics;
