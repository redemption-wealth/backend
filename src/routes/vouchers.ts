import { Hono } from "hono";
import { prisma } from "../db.js";
import { requireUser, type AuthEnv } from "../middleware/auth.js";
import { initiateRedemption } from "../services/redemption.js";
import { getLiveFeeConfig, injectFeeFields } from "../services/pricing.js";
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
    return c.json({ error: "Validation failed", details: query.error.flatten() }, 400);
  }

  const { merchantId, category, search, page, limit } = query.data;

  // Start of today in WIB (UTC+7)
  const nowWib = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Jakarta" }));
  nowWib.setHours(0, 0, 0, 0);
  const todayStartUtc = new Date(nowWib.getTime() - 7 * 60 * 60 * 1000);
  // Today's WIB calendar date at UTC midnight — startDate/expiryDate are @db.Date
  // columns stored at 00:00Z, so this lets us compare on the WIB calendar day.
  const todayDateUtc = new Date(todayStartUtc.getTime() + 7 * 60 * 60 * 1000);

  const where = {
    isActive: true,
    deletedAt: null,
    remainingStock: { gt: 0 },
    // Hide "Akan Datang" vouchers: only list those whose start day has arrived.
    startDate: { lte: todayDateUtc },
    expiryDate: { gte: todayStartUtc },
    merchant: {
      isActive: true,
      deletedAt: null,
      ...(category && { category: category as never }),
    },
    ...(merchantId && { merchantId }),
    ...(search && { title: { contains: search, mode: "insensitive" as const } }),
  };

  const [vouchersList, total, feeConfig] = await Promise.all([
    prisma.voucher.findMany({
      where,
      include: { merchant: true },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.voucher.count({ where }),
    getLiveFeeConfig(),
  ]);

  const { appFeeRate, gasFeeAmount } = feeConfig;

  return c.json({
    vouchers: vouchersList.map((v) => injectFeeFields(v, appFeeRate, gasFeeAmount)),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
});

// GET /api/vouchers/:id — Public: get voucher details
vouchers.get("/:id", async (c) => {
  const id = c.req.param("id");

  const voucher = await prisma.voucher.findUnique({
    where: { id },
    include: { merchant: true },
  });

  if (!voucher || voucher.deletedAt || !voucher.merchant?.isActive || voucher.merchant?.deletedAt) {
    return c.json({ error: "Voucher not found" }, 404);
  }

  // Only expose vouchers within their masa berlaku (validity window, WIB) and
  // still active — mirrors the public list filter so an early/stale link 404s
  // just like an "Akan Datang" or expired voucher is hidden from the list.
  const nowWib = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Jakarta" }));
  nowWib.setHours(0, 0, 0, 0);
  const todayDateUtc = new Date(nowWib.getTime());
  const expiryEnd = new Date(voucher.expiryDate);
  expiryEnd.setUTCHours(16, 59, 59, 999); // 23:59:59 WIB = 16:59:59 UTC
  const outsideValidity =
    !voucher.isActive ||
    voucher.startDate > todayDateUtc || // not started yet ("Akan Datang")
    expiryEnd < new Date(); // past its expiry day
  if (outsideValidity) {
    return c.json({ error: "Voucher not found" }, 404);
  }

  const { appFeeRate, gasFeeAmount } = await getLiveFeeConfig();
  return c.json({ voucher: injectFeeFields(voucher, appFeeRate, gasFeeAmount) });
});

// POST /api/vouchers/:id/redeem — User: redeem a voucher
vouchers.post("/:id/redeem", requireUser, async (c) => {
  const voucherId = c.req.param("id");
  const user = c.get("userAuth");
  const body = await c.req.json();

  const parsed = redeemVoucherSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
  }

  const { idempotencyKey } = parsed.data;

  try {
    const { redemption, alreadyExists } = await initiateRedemption({
      userEmail: user.userEmail,
      voucherId,
      idempotencyKey,
    });

    if (alreadyExists) {
      return c.json({ redemption, alreadyExists: true });
    }

    return c.json({
      redemption,
      txDetails: {
        tokenContractAddress: process.env.WEALTH_CONTRACT_ADDRESS,
        treasuryWalletAddress: process.env.DEV_WALLET_ADDRESS,
        wealthAmount: redemption.wealthAmount.toString(),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Redemption failed";
    const status = message.includes("Price service unavailable") ? 503 : 400;
    return c.json({ error: message }, status);
  }
});

export default vouchers;
