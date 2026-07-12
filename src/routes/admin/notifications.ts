import { Hono } from "hono";
import { prisma } from "../../db.js";
import { requireManager, type AuthEnv } from "../../middleware/auth.js";

const adminNotifications = new Hono<AuthEnv>();
adminNotifications.use("*", requireManager);

// Active rewards at or below this stock level surface as a notification.
const LOW_STOCK_THRESHOLD = 5;

interface NotificationItem {
  id: string;
  type: "wp_redemption_pending" | "wp_conversion_pending" | "reward_low_stock" | "reward_out_of_stock";
  title: string;
  detail: string;
  href: string;
  createdAt: Date;
}

// GET /api/admin/notifications — topbar bell feed. Entirely DERIVED from
// actionable state (no persistence): pending WP redemptions, pending WP
// conversions, and low/zero-stock active rewards.
adminNotifications.get("/", async (c) => {
  const [pendingRedemptions, pendingConversions, lowStockRewards] =
    await Promise.all([
      prisma.wpRedemption.aggregate({
        where: { status: "PENDING" },
        _count: { _all: true },
        _max: { createdAt: true },
      }),
      prisma.wpConversion.aggregate({
        where: { status: "PENDING" },
        _count: { _all: true },
        _max: { createdAt: true },
      }),
      prisma.wpReward.findMany({
        where: { isActive: true, stock: { not: null, lte: LOW_STOCK_THRESHOLD } },
        select: { id: true, title: true, stock: true, updatedAt: true },
        orderBy: { stock: "asc" },
        take: 20,
      }),
    ]);

  const items: NotificationItem[] = [];

  const redemptionCount = pendingRedemptions._count._all;
  if (redemptionCount > 0) {
    items.push({
      id: "wp_redemption_pending",
      type: "wp_redemption_pending",
      title: `${redemptionCount} penukaran WP menunggu`,
      detail: "Penukaran reward WP menunggu diproses.",
      href: "/admin/wealth-points/redemptions",
      createdAt: pendingRedemptions._max.createdAt ?? new Date(),
    });
  }

  const conversionCount = pendingConversions._count._all;
  if (conversionCount > 0) {
    items.push({
      id: "wp_conversion_pending",
      type: "wp_conversion_pending",
      title: `${conversionCount} konversi WP menunggu`,
      detail: "Konversi WP → $WEALTH menunggu ditransfer.",
      href: "/admin/wealth-points/conversions",
      createdAt: pendingConversions._max.createdAt ?? new Date(),
    });
  }

  for (const r of lowStockRewards) {
    const stock = r.stock ?? 0;
    const out = stock <= 0;
    items.push({
      id: `reward_stock_${r.id}`,
      type: out ? "reward_out_of_stock" : "reward_low_stock",
      title: out ? `Stok habis: ${r.title}` : `Stok menipis: ${r.title}`,
      detail: out ? "Reward aktif kehabisan stok." : `Stok tersisa ${stock}.`,
      href: "/admin/wealth-points/rewards",
      createdAt: r.updatedAt,
    });
  }

  items.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  return c.json({ count: items.length, items });
});

export default adminNotifications;
