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

  // startDate is offset by (bucketCount - 1) units so the query window lines up
  // exactly with the buckets produced by buildBuckets() — every bucket has a
  // matching range and no out-of-range record is silently dropped.
  switch (period) {
    case "daily":
      startDate.setDate(now.getDate() - 6);
      startDate.setHours(0, 0, 0, 0);
      return { startDate, endDate: now, bucketCount: 7 };
    case "yearly":
      startDate.setFullYear(now.getFullYear() - 4);
      return { startDate, endDate: now, bucketCount: 5 };
    case "monthly":
      startDate.setMonth(now.getMonth() - 5);
      return { startDate, endDate: now, bucketCount: 6 };
  }
}

// Produce every bucket label in the range (oldest → newest) so charts render a
// full, gap-free axis. Days/months/years with no activity become explicit 0s.
export function buildBuckets(period: "daily" | "yearly" | "monthly", bucketCount: number): string[] {
  const now = nowWib();
  const labels: string[] = [];
  for (let i = bucketCount - 1; i >= 0; i--) {
    const d = new Date(now);
    switch (period) {
      case "daily":
        d.setDate(now.getDate() - i);
        break;
      case "monthly":
        d.setMonth(now.getMonth() - i);
        break;
      case "yearly":
        d.setFullYear(now.getFullYear() - i);
        break;
    }
    labels.push(formatDateLabel(d, period));
  }
  return labels;
}

export function formatDateLabel(date: Date, period: "daily" | "yearly" | "monthly"): string {
  switch (period) {
    case "daily": {
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
      avgWealthResult,
      totalValueIdrResult,
      uniqueUsers,
    ] = await Promise.all([
      merchantId
        ? prisma.merchant.count({ where: { id: merchantId, isActive: true, deletedAt: null } })
        : prisma.merchant.count({ where: { isActive: true, deletedAt: null } }),
      prisma.voucher.count({ where: { isActive: true, deletedAt: null, ...voucherWhere } }),
      prisma.redemption.count({ where: redemptionWhere }),
      prisma.redemption.count({ where: { status: "CONFIRMED", ...redemptionWhere } }),
      prisma.redemption.aggregate({
        where: { status: "CONFIRMED", ...redemptionWhere },
        _sum: { wealthAmount: true },
      }),
      prisma.redemption.aggregate({
        where: { status: "CONFIRMED", ...redemptionWhere },
        _avg: { wealthAmount: true },
      }),
      prisma.redemption.aggregate({
        where: { status: "CONFIRMED", ...redemptionWhere },
        _sum: { priceIdrAtRedeem: true },
      }),
      // "Pengguna Redeem": distinct emails across ALL redemptions (any status),
      // not just CONFIRMED — measures everyone who has redeemed, not Privy
      // sign-ups (regular users have no User row). See brainstorm 2026-05-23.
      prisma.redemption.findMany({
        where: { ...redemptionWhere },
        select: { userEmail: true },
        distinct: ["userEmail"],
      }),
    ]);

    return {
      totalMerchants,
      totalVouchers,
      totalRedemptions,
      confirmedRedemptions,
      totalWealthVolume: wealthVolumeResult._sum.wealthAmount?.toString() || "0",
      totalUsers: uniqueUsers.length,
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
    const { startDate, bucketCount } = getDateRange(period);

    const redemptions = await prisma.redemption.findMany({
      where: {
        createdAt: { gte: startDate },
        ...(merchantId && { voucher: { merchantId } }),
      },
      select: { createdAt: true },
      orderBy: { createdAt: "asc" },
    });

    const grouped = new Map<string, number>();
    redemptions.forEach((r) => {
      const p = formatDateLabel(r.createdAt, period);
      grouped.set(p, (grouped.get(p) || 0) + 1);
    });

    // Zero-fill: every bucket in the range appears, even with no activity.
    return buildBuckets(period, bucketCount).map((label) => ({
      period: label,
      count: grouped.get(label) ?? 0,
    }));
  });
}

export async function getMerchantCategoryDistribution(merchantId?: string): Promise<
  Array<{ categoryName: string; count: number; percentage: number }>
> {
  const cacheKey = merchantId ? `merchant-categories:${merchantId}` : "merchant-categories";
  return getCachedOrCalculate(cacheKey, async () => {
    const merchants = await prisma.merchant.findMany({
      where: { isActive: true, deletedAt: null, ...(merchantId && { id: merchantId }) },
    });

    const total = merchants.length;
    const grouped = new Map<string, number>();
    merchants.forEach((m) => {
      const catName = m.category as string;
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
    const { startDate, bucketCount } = getDateRange(period);

    const redemptions = await prisma.redemption.findMany({
      where: {
        status: "CONFIRMED",
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

    // Zero-fill so the volume chart spans the full range.
    return buildBuckets(period, bucketCount).map((label) => ({
      period: label,
      volume: (grouped.get(label) ?? 0).toFixed(4),
    }));
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
        status: "CONFIRMED",
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
        status: "CONFIRMED",
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

// ─── KPI trend deltas (current period vs previous, equal-length window) ───────

export interface TrendMetric {
  current: number;
  previous: number;
  /** Percent change vs the previous window. null when previous is 0. */
  deltaPct: number | null;
}

function deltaPct(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return Math.round(((current - previous) / previous) * 10000) / 100;
}

/**
 * KPI trend deltas powering the dashboard's "▲ x% vs last period" chips. For the
 * given period we compare the current window [startDate, now] against the
 * immediately-preceding equal-length window. Returns redemption count,
 * confirmed-redemption count, and confirmed $WEALTH volume.
 */
export async function getKpiTrends(
  period: "daily" | "yearly" | "monthly",
  merchantId?: string
): Promise<{
  period: string;
  redemptions: TrendMetric;
  confirmedRedemptions: TrendMetric;
  wealthVolume: { current: string; previous: string; deltaPct: number | null };
}> {
  const cacheKey = merchantId ? `kpi-trends-${period}:${merchantId}` : `kpi-trends-${period}`;
  return getCachedOrCalculate(cacheKey, async () => {
    const { startDate, endDate } = getDateRange(period);
    const windowMs = endDate.getTime() - startDate.getTime();
    const prevStart = new Date(startDate.getTime() - windowMs);

    const scope = merchantId ? { voucher: { merchantId } } : {};

    const [curCount, prevCount, curConfirmed, prevConfirmed, curVol, prevVol] =
      await Promise.all([
        prisma.redemption.count({
          where: { createdAt: { gte: startDate, lte: endDate }, ...scope },
        }),
        prisma.redemption.count({
          where: { createdAt: { gte: prevStart, lt: startDate }, ...scope },
        }),
        prisma.redemption.count({
          where: {
            status: "CONFIRMED",
            confirmedAt: { gte: startDate, lte: endDate },
            ...scope,
          },
        }),
        prisma.redemption.count({
          where: {
            status: "CONFIRMED",
            confirmedAt: { gte: prevStart, lt: startDate },
            ...scope,
          },
        }),
        prisma.redemption.aggregate({
          _sum: { wealthAmount: true },
          where: {
            status: "CONFIRMED",
            confirmedAt: { gte: startDate, lte: endDate },
            ...scope,
          },
        }),
        prisma.redemption.aggregate({
          _sum: { wealthAmount: true },
          where: {
            status: "CONFIRMED",
            confirmedAt: { gte: prevStart, lt: startDate },
            ...scope,
          },
        }),
      ]);

    const curVolNum = Number(curVol._sum.wealthAmount ?? 0);
    const prevVolNum = Number(prevVol._sum.wealthAmount ?? 0);

    return {
      period,
      redemptions: {
        current: curCount,
        previous: prevCount,
        deltaPct: deltaPct(curCount, prevCount),
      },
      confirmedRedemptions: {
        current: curConfirmed,
        previous: prevConfirmed,
        deltaPct: deltaPct(curConfirmed, prevConfirmed),
      },
      wealthVolume: {
        current: curVolNum.toFixed(4),
        previous: prevVolNum.toFixed(4),
        deltaPct: deltaPct(curVolNum, prevVolNum),
      },
    };
  });
}

// ─── Redemption source breakdown (donut) ─────────────────────────────────────

/**
 * Where confirmed redemptions come from, grouped by the merchant category of the
 * redeemed voucher. Powers the dashboard's redemption-source donut. Distinct
 * from getMerchantCategoryDistribution, which counts merchants, not redemptions.
 */
export async function getRedemptionSourceBreakdown(
  merchantId?: string
): Promise<Array<{ categoryName: string; count: number; percentage: number }>> {
  const cacheKey = merchantId ? `redemption-sources:${merchantId}` : "redemption-sources";
  return getCachedOrCalculate(cacheKey, async () => {
    const redemptions = await prisma.redemption.findMany({
      where: {
        status: "CONFIRMED",
        ...(merchantId && { voucher: { merchantId } }),
      },
      select: { voucher: { select: { merchant: { select: { category: true } } } } },
    });

    const total = redemptions.length;
    const grouped = new Map<string, number>();
    redemptions.forEach((r) => {
      const cat = r.voucher.merchant.category as string;
      grouped.set(cat, (grouped.get(cat) || 0) + 1);
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

export function clearAnalyticsCache(): void {
  analyticsCache.flushAll();
  console.log("[Analytics] Cache cleared");
}
