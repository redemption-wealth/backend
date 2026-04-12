import { Hono } from "hono";
import { prisma } from "../../db.js";
import type { AuthEnv } from "../../middleware/auth.js";

const adminRedemptions = new Hono<AuthEnv>();

// GET /api/admin/redemptions — List all redemptions
adminRedemptions.get("/", async (c) => {
  const status = c.req.query("status");
  const page = parseInt(c.req.query("page") ?? "1");
  const limit = parseInt(c.req.query("limit") ?? "20");

  const where = {
    ...(status && { status: status as never }),
  };

  const [redemptionsList, total] = await Promise.all([
    prisma.redemption.findMany({
      where,
      include: {
        user: { select: { email: true, walletAddress: true } },
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
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  });
});

// GET /api/admin/redemptions/:id — Get redemption detail
adminRedemptions.get("/:id", async (c) => {
  const id = c.req.param("id");

  const redemption = await prisma.redemption.findUnique({
    where: { id },
    include: {
      user: { select: { email: true, walletAddress: true } },
      voucher: { include: { merchant: true } },
      qrCodes: true,
      transaction: true,
    },
  });

  if (!redemption) {
    return c.json({ error: "Redemption not found" }, 404);
  }

  return c.json({ redemption });
});

export default adminRedemptions;
