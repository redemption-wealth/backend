import { prisma } from "../db.js";

export async function getSummary() {
  const [
    totalMerchants,
    totalVouchers,
    activeVouchers,
    totalRedemptions,
    pendingRedemptions,
    wealthVolume,
  ] = await Promise.all([
    prisma.merchant.count({ where: { isActive: true } }),
    prisma.voucher.count(),
    prisma.voucher.count({
      where: { isActive: true, remainingStock: { gt: 0 } },
    }),
    prisma.redemption.count({ where: { status: "confirmed" } }),
    prisma.redemption.count({ where: { status: "pending" } }),
    prisma.redemption.aggregate({
      where: { status: "confirmed" },
      _sum: { wealthAmount: true },
    }),
  ]);

  return {
    totalMerchants,
    totalVouchers,
    activeVouchers,
    totalRedemptions,
    pendingRedemptions,
    totalWealthVolume: wealthVolume._sum.wealthAmount?.toString() ?? "0",
  };
}

export async function getRecentActivity(limit = 20) {
  return prisma.redemption.findMany({
    include: {
      user: { select: { email: true } },
      voucher: { include: { merchant: { select: { name: true } } } },
    },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}
