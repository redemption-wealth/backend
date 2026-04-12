import { Hono } from "hono";
import { prisma } from "../db.js";
import { requireUser, type AuthEnv } from "../middleware/auth.js";

const redemptions = new Hono<AuthEnv>();

// GET /api/redemptions — User: list own redemptions
redemptions.get("/", requireUser, async (c) => {
  const user = c.get("userAuth");
  const page = parseInt(c.req.query("page") ?? "1");
  const limit = parseInt(c.req.query("limit") ?? "20");
  const status = c.req.query("status");

  const where = {
    userId: user.userId,
    ...(status && { status: status as never }),
  };

  const [redemptionsList, total] = await Promise.all([
    prisma.redemption.findMany({
      where,
      include: {
        voucher: { include: { merchant: true } },
        qrCode: true,
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

// GET /api/redemptions/:id — User: get own redemption detail
redemptions.get("/:id", requireUser, async (c) => {
  const id = c.req.param("id");
  const user = c.get("userAuth");

  const redemption = await prisma.redemption.findFirst({
    where: { id, userId: user.userId },
    include: {
      voucher: { include: { merchant: true } },
      qrCode: true,
      transaction: true,
    },
  });

  if (!redemption) {
    return c.json({ error: "Redemption not found" }, 404);
  }

  return c.json({ redemption });
});

export default redemptions;
