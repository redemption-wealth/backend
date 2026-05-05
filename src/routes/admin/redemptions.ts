import { Hono } from "hono";
import { prisma } from "../../db.js";
import { requireOwner, type AuthEnv } from "../../middleware/auth.js";

const adminRedemptions = new Hono<AuthEnv>();

// GET /api/admin/redemptions/counts — Count by status (owner only)
// Must be registered before /:id to avoid param swallowing "counts"
adminRedemptions.get("/counts", requireOwner, async (c) => {
  const [all, confirmed, pending, failed] = await Promise.all([
    prisma.redemption.count(),
    prisma.redemption.count({ where: { status: "CONFIRMED" } }),
    prisma.redemption.count({ where: { status: "PENDING" } }),
    prisma.redemption.count({ where: { status: "FAILED" } }),
  ]);
  return c.json({ all, confirmed, pending, failed });
});

// GET /api/admin/redemptions/recent?limit=10 — Recent confirmed redemptions (owner only)
// Must be registered before /:id to avoid param swallowing "recent"
adminRedemptions.get("/recent", requireOwner, async (c) => {
  const limit = Math.min(parseInt(c.req.query("limit") ?? "10"), 50);

  const redemptions = await prisma.redemption.findMany({
    where: { status: "CONFIRMED" },
    include: {
      voucher: {
        select: {
          title: true,
          merchant: { select: { name: true } },
        },
      },
    },
    orderBy: { confirmedAt: "desc" },
    take: limit,
  });

  return c.json({
    redemptions: redemptions.map((r) => ({
      id: r.id,
      userEmail: r.userEmail,
      status: r.status,
      confirmedAt: r.confirmedAt,
      voucher: r.voucher,
    })),
  });
});

// GET /api/admin/redemptions — List redemptions (owner only)
adminRedemptions.get("/", requireOwner, async (c) => {
  const adminAuth = c.get("adminAuth");
  const status = c.req.query("status");
  const page = parseInt(c.req.query("page") ?? "1");
  const limit = parseInt(c.req.query("limit") ?? "20");

  const where = {
    ...(status && { status: status as never }),
    ...(adminAuth.role === "ADMIN" && adminAuth.merchantId && {
      voucher: { merchantId: adminAuth.merchantId },
    }),
  };

  const [redemptionsList, total] = await Promise.all([
    prisma.redemption.findMany({
      where,
      include: {
        voucher: { include: { merchant: true } },
        qrCodes: true,
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.redemption.count({ where }),
  ]);

  return c.json({
    redemptions: redemptionsList,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
});

// GET /api/admin/redemptions/:id — Get redemption detail (owner only)
adminRedemptions.get("/:id", requireOwner, async (c) => {
  const id = c.req.param("id");

  const redemption = await prisma.redemption.findUnique({
    where: { id },
    include: {
      voucher: { include: { merchant: true } },
      qrCodes: true,
    },
  });

  if (!redemption) {
    return c.json({ error: "Redemption not found" }, 404);
  }

  return c.json({ redemption });
});

export default adminRedemptions;
