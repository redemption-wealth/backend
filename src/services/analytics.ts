import NodeCache from "node-cache";
import { prisma } from "../db.js";

const analyticsCache = new NodeCache({
  stdTTL: 300,
  checkperiod: 60,
});

async function getCachedOrCalculate<T>(
  key: string,
  calculateFn: () => Promise<T>
): Promise<T> {
  const cached = analyticsCache.get<T>(key);
  if (cached !== undefined) {
    console.log("[Analytics] Cache hit: " + key);
    return cached;
  }

  console.log("[Analytics] Cache miss: " + key + ", calculating...");
  const result = await calculateFn();
  analyticsCache.set(key, result);

  return result;
}

export function getDateRange(period: "daily" | "yearly" | "monthly"): {
  startDate: Date;
  endDate: Date;
  bucketCount: number;
} {
  const now = new Date();
  const startDate = new Date(now);

  switch (period) {
    case "daily":
      startDate.setDate(now.getDate() - 7);
      return { startDate, endDate: now, bucketCount: 7 };
    case "yearly":
      startDate.setFullYear(now.getFullYear() - 5);
      return { startDate, endDate: now, bucketCount: 5 };
    case "monthly":
      startDate.setMonth(now.getMonth() - 6);
      return { startDate, endDate: now, bucketCount: 6 };
  }
}

export function formatDateLabel(date: Date, period: "daily" | "yearly" | "monthly"): string {
  switch (period) {
    case "daily":
      return date.toISOString().split("T")[0];
    case "yearly":
      return date.getFullYear().toString();
    case "monthly":
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, "0");
      return year + "-" + month;
  }
}

export async function getSummaryStats(): Promise<{
  totalMerchants: number;
  totalVouchers: number;
  totalRedemptions: number;
  confirmedRedemptions: number;
  totalWealthVolume: string;
  totalUsers: number;
  avgWealthPerRedeem: string;
  totalValueIdr: number;
}> {
  return getCachedOrCalculate("summary-stats", async () => {
    const [
      totalMerchants,
      totalVouchers,
      totalRedemptions,
      confirmedRedemptions,
      wealthVolumeResult,
      totalUsers,
      avgWealthResult,
      totalValueIdrResult,
    ] = await Promise.all([
      prisma.merchant.count({ where: { isActive: true } }),
      prisma.voucher.count({ where: { isActive: true } }),
      prisma.redemption.count(),
      prisma.redemption.count({ where: { status: "confirmed" } }),
      prisma.redemption.aggregate({
        where: { status: "confirmed" },
        _sum: { wealthAmount: true },
      }),
      prisma.user.count(),
      prisma.redemption.aggregate({
        where: { status: "confirmed" },
        _avg: { wealthAmount: true },
      }),
      prisma.redemption.aggregate({
        where: { status: "confirmed" },
        _sum: { priceIdrAtRedeem: true },
      }),
    ]);

    return {
      totalMerchants,
      totalVouchers,
      totalRedemptions,
      confirmedRedemptions,
      totalWealthVolume: wealthVolumeResult._sum.wealthAmount?.toString() || "0",
      totalUsers,
      avgWealthPerRedeem: avgWealthResult._avg.wealthAmount?.toString() || "0",
      totalValueIdr: totalValueIdrResult._sum.priceIdrAtRedeem || 0,
    };
  });
}

export async function getRedemptionsOverTime(period: "daily" | "yearly" | "monthly"): Promise<
  Array<{ label: string; count: number }>
> {
  return getCachedOrCalculate("redemptions-over-time-" + period, async () => {
    const { startDate } = getDateRange(period);

    const redemptions = await prisma.redemption.findMany({
      where: {
        redeemedAt: { gte: startDate },
      },
      select: {
        redeemedAt: true,
      },
      orderBy: { redeemedAt: "asc" },
    });

    const grouped = new Map<string, number>();

    redemptions.forEach((r) => {
      const label = formatDateLabel(r.redeemedAt, period);
      grouped.set(label, (grouped.get(label) || 0) + 1);
    });

    return Array.from(grouped.entries())
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => a.label.localeCompare(b.label));
  });
}

export async function getMerchantCategoryDistribution(): Promise<
  Array<{ category: string; count: number; percentage: number }>
> {
  return getCachedOrCalculate("merchant-categories", async () => {
    const merchants = await prisma.merchant.findMany({
      where: { isActive: true },
      include: { category: true },
    });

    const total = merchants.length;
    const grouped = new Map<string, number>();

    merchants.forEach((m) => {
      const categoryName = m.category.name;
      grouped.set(categoryName, (grouped.get(categoryName) || 0) + 1);
    });

    return Array.from(grouped.entries())
      .map(([category, count]) => ({
        category,
        count,
        percentage: total > 0 ? Math.round((count / total) * 100) : 0,
      }))
      .sort((a, b) => b.count - a.count);
  });
}

export async function getWealthVolumeOverTime(period: "daily" | "yearly" | "monthly"): Promise<
  Array<{ label: string; volume: string }>
> {
  return getCachedOrCalculate("wealth-volume-" + period, async () => {
    const { startDate } = getDateRange(period);

    const redemptions = await prisma.redemption.findMany({
      where: {
        status: "confirmed",
        confirmedAt: { gte: startDate },
      },
      select: {
        confirmedAt: true,
        wealthAmount: true,
      },
      orderBy: { confirmedAt: "asc" },
    });

    const grouped = new Map<string, number>();

    redemptions.forEach((r) => {
      if (!r.confirmedAt) return;

      const label = formatDateLabel(r.confirmedAt, period);
      const currentSum = grouped.get(label) || 0;
      grouped.set(label, currentSum + Number(r.wealthAmount));
    });

    return Array.from(grouped.entries())
      .map(([label, volume]) => ({
        label,
        volume: volume.toFixed(3),
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  });
}

export async function getTopMerchants(limit: number = 3): Promise<
  Array<{
    id: string;
    name: string;
    logoUrl: string | null;
    redeemCount: number;
    wealthVolume: string;
  }>
> {
  return getCachedOrCalculate("top-merchants-" + limit, async () => {
    const redemptions = await prisma.redemption.findMany({
      where: { status: "confirmed" },
      include: {
        voucher: {
          include: {
            merchant: true,
          },
        },
      },
    });

    const merchantStats = new Map<
      string,
      {
        id: string;
        name: string;
        logoUrl: string | null;
        redeemCount: number;
        wealthVolume: number;
      }
    >();

    redemptions.forEach((r) => {
      const merchant = r.voucher.merchant;
      const stats = merchantStats.get(merchant.id) || {
        id: merchant.id,
        name: merchant.name,
        logoUrl: merchant.logoUrl,
        redeemCount: 0,
        wealthVolume: 0,
      };

      stats.redeemCount++;
      stats.wealthVolume += Number(r.wealthAmount);

      merchantStats.set(merchant.id, stats);
    });

    return Array.from(merchantStats.values())
      .map((m) => ({
        ...m,
        wealthVolume: m.wealthVolume.toFixed(2),
      }))
      .sort((a, b) => b.redeemCount - a.redeemCount)
      .slice(0, limit);
  });
}

export async function getTopVouchers(limit: number = 3): Promise<
  Array<{
    id: string;
    title: string;
    merchantName: string;
    redeemCount: number;
    wealthVolume: string;
  }>
> {
  return getCachedOrCalculate("top-vouchers-" + limit, async () => {
    const redemptions = await prisma.redemption.findMany({
      where: { status: "confirmed" },
      include: {
        voucher: {
          include: {
            merchant: true,
          },
        },
      },
    });

    const voucherStats = new Map<
      string,
      {
        id: string;
        title: string;
        merchantName: string;
        redeemCount: number;
        wealthVolume: number;
      }
    >();

    redemptions.forEach((r) => {
      const voucher = r.voucher;
      const stats = voucherStats.get(voucher.id) || {
        id: voucher.id,
        title: voucher.title,
        merchantName: voucher.merchant.name,
        redeemCount: 0,
        wealthVolume: 0,
      };

      stats.redeemCount++;
      stats.wealthVolume += Number(r.wealthAmount);

      voucherStats.set(voucher.id, stats);
    });

    return Array.from(voucherStats.values())
      .map((v) => ({
        ...v,
        wealthVolume: v.wealthVolume.toFixed(2),
      }))
      .sort((a, b) => b.redeemCount - a.redeemCount)
      .slice(0, limit);
  });
}

export function clearAnalyticsCache(): void {
  analyticsCache.flushAll();
  console.log("[Analytics] Cache cleared");
}
