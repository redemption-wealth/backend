import { Hono } from "hono";
import { prisma } from "../../db.js";
import { requireManagerOrAdmin, type AuthEnv } from "../../middleware/auth.js";
import { MERCHANT_CATEGORIES } from "../../lib/categories.js";

const adminOverview = new Hono<AuthEnv>();

// GET /api/admin/overview — Dashboard overview counts (manager/admin only)
adminOverview.get("/overview", requireManagerOrAdmin, async (c) => {
  const [totalMerchants, totalVouchers, totalQrAvailable] = await Promise.all([
    prisma.merchant.count({ where: { isActive: true, deletedAt: null } }),
    prisma.voucher.count({ where: { isActive: true, deletedAt: null } }),
    prisma.qrCode.count({ where: { status: "AVAILABLE" } }),
  ]);
  return c.json({ totalMerchants, totalVouchers, totalQrAvailable });
});

// GET /api/admin/categories — Canonical merchant category list (labels).
adminOverview.get("/categories", async (c) => {
  return c.json({ categories: [...MERCHANT_CATEGORIES] });
});

export default adminOverview;
