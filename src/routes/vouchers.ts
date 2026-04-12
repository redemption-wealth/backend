import { Hono } from "hono";
import { prisma } from "../db.js";
import { requireUser, type AuthEnv } from "../middleware/auth.js";
import { initiateRedemption } from "../services/redemption.js";

const vouchers = new Hono<AuthEnv>();

// GET /api/vouchers — Public: list active vouchers
vouchers.get("/", async (c) => {
  const merchantId = c.req.query("merchantId");
  const category = c.req.query("category");
  const search = c.req.query("search");
  const page = parseInt(c.req.query("page") ?? "1");
  const limit = parseInt(c.req.query("limit") ?? "20");

  const where = {
    isActive: true,
    remainingStock: { gt: 0 },
    endDate: { gte: new Date() },
    ...(merchantId && { merchantId }),
    ...(category && {
      merchant: { category: category as never },
    }),
    ...(search && {
      title: { contains: search, mode: "insensitive" as const },
    }),
  };

  const [vouchersList, total] = await Promise.all([
    prisma.voucher.findMany({
      where,
      include: { merchant: true },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.voucher.count({ where }),
  ]);

  return c.json({
    vouchers: vouchersList,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  });
});

// GET /api/vouchers/:id — Public: get voucher details
vouchers.get("/:id", async (c) => {
  const id = c.req.param("id");

  const voucher = await prisma.voucher.findUnique({
    where: { id },
    include: { merchant: true },
  });

  if (!voucher) {
    return c.json({ error: "Voucher not found" }, 404);
  }

  return c.json({ voucher });
});

// POST /api/vouchers/:id/redeem — User: redeem a voucher
vouchers.post("/:id/redeem", requireUser, async (c) => {
  const voucherId = c.req.param("id");
  const user = c.get("userAuth");
  const { idempotencyKey, wealthPriceIdr } = await c.req.json();

  if (!idempotencyKey || !wealthPriceIdr) {
    return c.json(
      { error: "idempotencyKey and wealthPriceIdr are required" },
      400
    );
  }

  try {
    const { redemption, alreadyExists } = await initiateRedemption({
      userId: user.userId,
      voucherId,
      idempotencyKey,
      wealthPriceIdr,
    });

    if (alreadyExists) {
      return c.json({ redemption, alreadyExists: true });
    }

    const settings = await prisma.appSettings.findUnique({
      where: { id: "singleton" },
    });

    return c.json({
      redemption,
      txDetails: {
        tokenContractAddress: settings?.tokenContractAddress,
        treasuryWalletAddress: settings?.treasuryWalletAddress,
        wealthAmount: redemption.wealthAmount.toString(),
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Redemption failed";
    return c.json({ error: message }, 400);
  }
});

export default vouchers;
