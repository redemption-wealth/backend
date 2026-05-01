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

const WIB_TZ = "Asia/Jakarta";

/** Get current time as WIB date parts */
function nowWib() {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: WIB_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(new Date()).map((p) => [p.type, p.value])
  );
  return new Date(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}+07:00`);
}

export function getDateRange(period: "daily" | "yearly" | "monthly"): {
  startDate: Date;
  endDate: Date;
  bucketCount: number;
} {
  const now = nowWib();
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
    case "daily": {
      // Format in WIB timezone to get correct local date
      const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: WIB_TZ, year: "numeric", month: "2-digit", day: "2-digit" });
      return fmt.format(date);
    }
    case "yearly": {
      const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: WIB_TZ, year: "numeric" });
      return fmt.format(date);
    }
    case "monthly": {
      const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: WIB_TZ, year: "numeric", month: "2-digit" });
      return fmt.format(date);
    }
  }
}

export async function getSummaryStats(merchantId?: string): Promise<{
  totalMerchants: number;
  totalVouchers: number;
  totalRedemptions: number;
  confirmedRedemptions: number;
  totalWealthVolume: string;
  totalUsers: number;
  avgWealthPerRedeem: string;
  totalValueIdr: number;
}> {
  const cacheKey = merchantId ? `summary-stats:${merchantId}` : "summary-stats";
  return getCachedOrCalculate(cacheKey, async () => {
    const redemptionWhere = merchantId
      ? { voucher: { merchantId } }
      : {};
    const voucherWhere = merchantId ? { merchantId } : {};

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
      merchantId
        ? prisma.merchant.count({ where: { id: merchantId, isActive: true } })
        : prisma.merchant.count({ where: { isActive: true } }),
      prisma.voucher.count({ where: { isActive: true, ...voucherWhere } }),
      prisma.redemption.count({ where: redemptionWhere }),
      prisma.redemption.count({ where: { status: "confirmed", ...redemptionWhere } }),
      prisma.redemption.aggregate({
        where: { status: "confirmed", ...redemptionWhere },
        _sum: { wealthAmount: true },
      }),
      merchantId ? Promise.resolve(0) : prisma.user.count(),
      prisma.redemption.aggregate({
        where: { status: "confirmed", ...redemptionWhere },
        _avg: { wealthAmount: true },
      }),
      prisma.redemption.aggregate({
        where: { status: "confirmed", ...redemptionWhere },
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

export async function getRedemptionsOverTime(
  period: "daily" | "yearly" | "monthly",
  merchantId?: string
): Promise<Array<{ period: string; count: number }>> {
  const cacheKey = merchantId
    ? `redemptions-over-time-${period}:${merchantId}`
    : `redemptions-over-time-${period}`;
  return getCachedOrCalculate(cacheKey, async () => {
    const { startDate } = getDateRange(period);

    const redemptions = await prisma.redemption.findMany({
      where: {
        redeemedAt: { gte: startDate },
        ...(merchantId && { voucher: { merchantId } }),
      },
      select: { redeemedAt: true },
      orderBy: { redeemedAt: "asc" },
    });

    const grouped = new Map<string, number>();
    redemptions.forEach((r) => {
      const p = formatDateLabel(r.redeemedAt, period);
      grouped.set(p, (grouped.get(p) || 0) + 1);
    });

    return Array.from(grouped.entries())
      .map(([period, count]) => ({ period, count }))
      .sort((a, b) => a.period.localeCompare(b.period));
  });
}

export async function getMerchantCategoryDistribution(merchantId?: string): Promise<
  Array<{ categoryName: string; count: number; percentage: number }>
> {
  const cacheKey = merchantId ? `merchant-categories:${merchantId}` : "merchant-categories";
  return getCachedOrCalculate(cacheKey, async () => {
    const merchants = await prisma.merchant.findMany({
      where: { isActive: true, ...(merchantId && { id: merchantId }) },
      include: { category: true },
    });

    const total = merchants.length;
    const grouped = new Map<string, number>();
    merchants.forEach((m) => {
      const catName = m.category.name;
      grouped.set(catName, (grouped.get(catName) || 0) + 1);
    });

    return Array.from(grouped.entries())
      .map(([categoryName, count]) => ({
        categoryName,
        count,
        percentage: total > 0 ? Math.round((count / total) * 100) : 0,
      }))
      .sort((a, b) => b.count - a.count);
  });
}

export async function getWealthVolumeOverTime(
  period: "daily" | "yearly" | "monthly",
  merchantId?: string
): Promise<Array<{ period: string; volume: string }>> {
  const cacheKey = merchantId
    ? `wealth-volume-${period}:${merchantId}`
    : `wealth-volume-${period}`;
  return getCachedOrCalculate(cacheKey, async () => {
    const { startDate } = getDateRange(period);

    const redemptions = await prisma.redemption.findMany({
      where: {
        status: "confirmed",
        confirmedAt: { gte: startDate },
        ...(merchantId && { voucher: { merchantId } }),
      },
      select: { confirmedAt: true, wealthAmount: true },
      orderBy: { confirmedAt: "asc" },
    });

    const grouped = new Map<string, number>();
    redemptions.forEach((r) => {
      if (!r.confirmedAt) return;
      const p = formatDateLabel(r.confirmedAt, period);
      grouped.set(p, (grouped.get(p) || 0) + Number(r.wealthAmount));
    });

    return Array.from(grouped.entries())
      .map(([period, volume]) => ({ period, volume: volume.toFixed(4) }))
      .sort((a, b) => a.period.localeCompare(b.period));
  });
}

export async function getTopMerchants(
  limit: number = 3,
  merchantId?: string
): Promise<
  Array<{
    merchantId: string;
    merchantName: string;
    logoUrl: string | null;
    redemptionCount: number;
    wealthVolume: string;
  }>
> {
  const cacheKey = merchantId
    ? `top-merchants-${limit}:${merchantId}`
    : `top-merchants-${limit}`;
  return getCachedOrCalculate(cacheKey, async () => {
    const redemptions = await prisma.redemption.findMany({
      where: {
        status: "confirmed",
        ...(merchantId && { voucher: { merchantId } }),
      },
      include: { voucher: { include: { merchant: true } } },
    });

    const merchantStats = new Map<
      string,
      { merchantId: string; merchantName: string; logoUrl: string | null; redemptionCount: number; wealthVolume: number }
    >();

    redemptions.forEach((r) => {
      const merchant = r.voucher.merchant;
      const stats = merchantStats.get(merchant.id) || {
        merchantId: merchant.id,
        merchantName: merchant.name,
        logoUrl: merchant.logoUrl,
        redemptionCount: 0,
        wealthVolume: 0,
      };
      stats.redemptionCount++;
      stats.wealthVolume += Number(r.wealthAmount);
      merchantStats.set(merchant.id, stats);
    });

    return Array.from(merchantStats.values())
      .map((m) => ({ ...m, wealthVolume: m.wealthVolume.toFixed(4) }))
      .sort((a, b) => b.redemptionCount - a.redemptionCount)
      .slice(0, limit);
  });
}

export async function getTopVouchers(
  limit: number = 3,
  merchantId?: string
): Promise<
  Array<{
    voucherId: string;
    voucherTitle: string;
    merchantName: string;
    redemptionCount: number;
    wealthVolume: string;
  }>
> {
  const cacheKey = merchantId
    ? `top-vouchers-${limit}:${merchantId}`
    : `top-vouchers-${limit}`;
  return getCachedOrCalculate(cacheKey, async () => {
    const redemptions = await prisma.redemption.findMany({
      where: {
        status: "confirmed",
        ...(merchantId && { voucher: { merchantId } }),
      },
      include: { voucher: { include: { merchant: true } } },
    });

    const voucherStats = new Map<
      string,
      { voucherId: string; voucherTitle: string; merchantName: string; redemptionCount: number; wealthVolume: number }
    >();

    redemptions.forEach((r) => {
      const voucher = r.voucher;
      const stats = voucherStats.get(voucher.id) || {
        voucherId: voucher.id,
        voucherTitle: voucher.title,
        merchantName: voucher.merchant.name,
        redemptionCount: 0,
        wealthVolume: 0,
      };
      stats.redemptionCount++;
      stats.wealthVolume += Number(r.wealthAmount);
      voucherStats.set(voucher.id, stats);
    });

    return Array.from(voucherStats.values())
      .map((v) => ({ ...v, wealthVolume: v.wealthVolume.toFixed(4) }))
      .sort((a, b) => b.redemptionCount - a.redemptionCount)
      .slice(0, limit);
  });
}

export function clearAnalyticsCache(): void {
  analyticsCache.flushAll();
  console.log("[Analytics] Cache cleared");
}
