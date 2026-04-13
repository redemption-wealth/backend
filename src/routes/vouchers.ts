import { Hono } from "hono";
import { prisma } from "../db.js";
import { requireUser, type AuthEnv } from "../middleware/auth.js";
import { initiateRedemption } from "../services/redemption.js";
import { redeemVoucherSchema, voucherQuerySchema } from "../schemas/voucher.js";

const vouchers = new Hono<AuthEnv>();

// GET /api/vouchers — Public: list active vouchers
vouchers.get("/", async (c) => {
  const query = voucherQuerySchema.safeParse({
    merchantId: c.req.query("merchantId"),
    category: c.req.query("category") || undefined,
    search: c.req.query("search") || undefined,
    page: c.req.query("page"),
    limit: c.req.query("limit"),
  });

  if (!query.success) {
    return c.json(
      { error: "Validation failed", details: query.error.flatten() },
      400
    );
  }

  const { merchantId, category, search, page, limit } = query.data;

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
      include: {
        merchant: true,
        _count: {
          select: {
            qrCodes: {
              where: { status: "available" }
            }
          }
        }
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.voucher.count({ where }),
  ]);

  // Calculate stock breakdown
  const vouchersWithStock = vouchersList.map((v) => {
    const availableQrCount = v._count.qrCodes;
    const availableStock = Math.floor(availableQrCount / v.qrPerRedemption);

    const totalQrCodes = v.totalStock * v.qrPerRedemption;
    const usedQrCodes = v.usedStock * v.qrPerRedemption;
    const assignedQrCount = totalQrCodes - usedQrCodes - availableQrCount;
    const assignedStock = Math.floor(assignedQrCount / v.qrPerRedemption);

    return {
      ...v,
      availableStock,   // e.g., 48 (can be redeemed now)
      assignedStock,    // e.g., 2 (pending confirmation)
      usedStock: v.usedStock,  // e.g., 50 (completed)
      totalStock: v.totalStock, // e.g., 100
      isAvailable: availableStock > 0,
    };
  });

  return c.json({
    vouchers: vouchersWithStock,
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
  const body = await c.req.json();

  const parsed = redeemVoucherSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      400
    );
  }

  const { idempotencyKey, wealthPriceIdr } = parsed.data;

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
