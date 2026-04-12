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

// GET /api/redemptions/:id — User: get own redemption detail
redemptions.get("/:id", requireUser, async (c) => {
  const id = c.req.param("id");
  const user = c.get("userAuth");

  const redemption = await prisma.redemption.findFirst({
    where: { id, userId: user.userId },
    include: {
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

// PATCH /api/redemptions/:id/submit-tx — User: submit txHash
redemptions.patch("/:id/submit-tx", requireUser, async (c) => {
  const id = c.req.param("id");
  const user = c.get("userAuth");
  const { txHash } = await c.req.json();

  if (!txHash || typeof txHash !== "string") {
    return c.json({ error: "txHash is required" }, 400);
  }

  // Validate txHash format (0x-prefixed hex, 66 chars)
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return c.json({ error: "Invalid txHash format" }, 400);
  }

  const redemption = await prisma.redemption.findFirst({
    where: { id, userId: user.userId },
  });

  if (!redemption) {
    return c.json({ error: "Redemption not found" }, 404);
  }

  if (redemption.status !== "pending") {
    return c.json({ error: "Redemption is not pending" }, 400);
  }

  // Check txHash uniqueness
  const existingTx = await prisma.redemption.findUnique({
    where: { txHash },
  });
  if (existingTx) {
    return c.json({ error: "txHash already used" }, 400);
  }

  const updated = await prisma.redemption.update({
    where: { id: redemption.id },
    data: { txHash },
  });

  return c.json({ redemption: updated });
});

export default redemptions;
