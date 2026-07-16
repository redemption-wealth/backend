import { Hono } from "hono";
import { Prisma } from "@prisma/client";
import { prisma } from "../../db.js";
import {
  requireManager,
  requireOwner,
  type AuthEnv,
} from "../../middleware/auth.js";
import { parseSort, buildOrderBy } from "../../lib/list-query.js";
import { getDateRange } from "../../services/analytics.js";
import {
  ensureQrAssigned,
  reconcileRedemptionById,
} from "../../services/redemption.js";
import { refundRedemption } from "../../services/refund.js";

const adminRedemptions = new Hono<AuthEnv>();

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

// GET /api/admin/redemptions/counts — Count by status (owner only)
// Must be registered before /:id to avoid param swallowing "counts"
adminRedemptions.get("/counts", requireOwner, async (c) => {
  const [all, confirmed, pending, failed, expired, refunded] = await Promise.all([
    prisma.redemption.count(),
    prisma.redemption.count({ where: { status: "CONFIRMED" } }),
    prisma.redemption.count({ where: { status: "PENDING" } }),
    prisma.redemption.count({ where: { status: "FAILED" } }),
    prisma.redemption.count({ where: { status: "EXPIRED" } }),
    prisma.redemption.count({ where: { status: "REFUNDED" } }),
  ]);
  return c.json({ all, confirmed, pending, failed, expired, refunded });
});

// GET /api/admin/redemptions/recent?limit=10&period=daily|monthly|yearly
// Recent confirmed redemptions (owner only), constrained to the dashboard's
// selected date-range window so "recent" tracks the topbar period filter.
// Must be registered before /:id to avoid param swallowing "recent"
adminRedemptions.get("/recent", requireOwner, async (c) => {
  const limit = Math.min(parseInt(c.req.query("limit") ?? "10"), 50);
  const period = (c.req.query("period") || "monthly") as "daily" | "yearly" | "monthly";

  if (!["daily", "yearly", "monthly"].includes(period)) {
    return c.json({ error: "Invalid period. Use: daily, yearly, or monthly" }, 400);
  }

  const { startDate } = getDateRange(period);

  const redemptions = await prisma.redemption.findMany({
    where: { status: "CONFIRMED", createdAt: { gte: startDate } },
    include: {
      voucher: {
        select: {
          title: true,
          merchant: { select: { name: true, logoUrl: true } },
        },
      },
    },
    orderBy: { confirmedAt: "desc" },
    take: limit,
  });

  return c.json({
    redemptions: redemptions.map((r) => ({
      id: r.id,
      status: r.status,
      wealthAmount: r.wealthAmount.toString(),
      confirmedAt: r.confirmedAt,
      redeemedAt: r.createdAt,
      user: { email: r.userEmail },
      voucher: r.voucher,
    })),
  });
});

// GET /api/admin/redemptions — List redemptions (owner only)
adminRedemptions.get("/", requireOwner, async (c) => {
  // Normalise + validate the status filter. The UI sends lowercase
  // (?status=confirmed) but the enum is upper-case; passing the raw value to
  // Prisma threw an enum error → 500. Ignore anything that isn't a real status.
  const REDEMPTION_STATUSES = [
    "PENDING",
    "CONFIRMED",
    "FAILED",
    "EXPIRED",
    "REFUNDED",
  ] as const;
  const statusRaw = c.req.query("status")?.toUpperCase();
  const status = REDEMPTION_STATUSES.includes(
    statusRaw as (typeof REDEMPTION_STATUSES)[number],
  )
    ? (statusRaw as (typeof REDEMPTION_STATUSES)[number])
    : undefined;
  const search = c.req.query("search")?.trim();
  const page = parseInt(c.req.query("page") ?? "1");
  const limit = parseInt(c.req.query("limit") ?? "20");

  const where: Prisma.RedemptionWhereInput = {
    ...(status && { status }),
    ...(search && {
      OR: [
        { userEmail: { contains: search, mode: "insensitive" } },
        { voucher: { title: { contains: search, mode: "insensitive" } } },
        { voucher: { merchant: { name: { contains: search, mode: "insensitive" } } } },
      ],
    }),
  };

  const orderBy = buildOrderBy<Prisma.RedemptionOrderByWithRelationInput>(
    parseSort(c),
    {
      user: (dir) => ({ userEmail: dir }),
      voucher: (dir) => ({ voucher: { title: dir } }),
      wealth: (dir) => ({ wealthAmount: dir }),
      wealthAmount: (dir) => ({ wealthAmount: dir }),
      status: (dir) => ({ status: dir }),
      redeemedAt: (dir) => ({ createdAt: dir }),
      createdAt: (dir) => ({ createdAt: dir }),
    },
    (dir) => ({ createdAt: dir }),
  );

  const [redemptionsList, total] = await Promise.all([
    prisma.redemption.findMany({
      where,
      include: {
        voucher: { include: { merchant: true } },
        qrCodes: true,
      },
      orderBy,
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.redemption.count({ where }),
  ]);

  return c.json({
    redemptions: redemptionsList.map((r) => ({
      id: r.id,
      voucherId: r.voucherId,
      merchantId: r.merchantId,
      slotId: r.slotId,
      wealthAmount: r.wealthAmount.toString(),
      priceIdrAtRedeem: r.priceIdrAtRedeem,
      wealthPriceIdrAtRedeem: r.wealthPriceIdrAtRedeem.toString(),
      appFeeAmount: r.appFeeAmount.toString(),
      gasFeeAmount: r.gasFeeAmount.toString(),
      txHash: r.txHash,
      walletAddress: r.walletAddress,
      status: r.status,
      confirmedAt: r.confirmedAt,
      failedAt: r.failedAt,
      refundTxHash: r.refundTxHash,
      refundedAt: r.refundedAt,
      redeemedAt: r.createdAt,
      user: { email: r.userEmail },
      voucher: r.voucher,
      qrCodes: r.qrCodes,
    })),
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

  return c.json({
    redemption: {
      id: redemption.id,
      voucherId: redemption.voucherId,
      merchantId: redemption.merchantId,
      slotId: redemption.slotId,
      wealthAmount: redemption.wealthAmount.toString(),
      priceIdrAtRedeem: redemption.priceIdrAtRedeem,
      wealthPriceIdrAtRedeem: redemption.wealthPriceIdrAtRedeem.toString(),
      appFeeAmount: redemption.appFeeAmount.toString(),
      gasFeeAmount: redemption.gasFeeAmount.toString(),
      txHash: redemption.txHash,
      walletAddress: redemption.walletAddress,
      status: redemption.status,
      confirmedAt: redemption.confirmedAt,
      failedAt: redemption.failedAt,
      refundTxHash: redemption.refundTxHash,
      refundedAt: redemption.refundedAt,
      redeemedAt: redemption.createdAt,
      user: { email: redemption.userEmail },
      voucher: redemption.voucher,
      qrCodes: redemption.qrCodes,
    },
  });
});

// POST /api/admin/redemptions/:id/reconcile — force an on-chain re-check
// (manager) — same service the user-facing reconcile uses.
adminRedemptions.post("/:id/reconcile", requireManager, async (c) => {
  const id = c.req.param("id");
  try {
    const outcome = await reconcileRedemptionById(id);
    return c.json({ ok: true, outcome });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "Reconcile failed" },
      400,
    );
  }
});

// POST /api/admin/redemptions/:id/resend-assets — "Kirim voucher manual":
// re-run the idempotent QR/barcode assignment for a CONFIRMED redemption
// whose assets did not come through (manager).
adminRedemptions.post("/:id/resend-assets", requireManager, async (c) => {
  const id = c.req.param("id");
  const redemption = await prisma.redemption.findUnique({
    where: { id },
    select: { id: true, status: true },
  });
  if (!redemption) return c.json({ error: "Redemption not found" }, 404);
  if (redemption.status !== "CONFIRMED") {
    return c.json({ error: "Redemption is not CONFIRMED" }, 400);
  }
  try {
    await ensureQrAssigned(id);
    const qrCodes = await prisma.qrCode.findMany({
      where: { redemptionId: id },
      select: { id: true, status: true },
    });
    return c.json({ ok: true, qrAssigned: qrCodes.length });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "Asset assignment failed" },
      400,
    );
  }
});

// POST /api/admin/redemptions/:id/refund — record a VERIFIED on-chain refund
// (manager). Semi-manual flow: the admin already sent $WEALTH back from the
// treasury by hand; the backend verifies token/sender/recipient/amount
// on-chain before anything is recorded.
adminRedemptions.post("/:id/refund", requireManager, async (c) => {
  const id = c.req.param("id");
  const admin = c.get("adminAuth");
  let body: { refundTxHash?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  if (
    !body.refundTxHash ||
    typeof body.refundTxHash !== "string" ||
    !TX_HASH_RE.test(body.refundTxHash)
  ) {
    return c.json({ error: "Valid refundTxHash is required" }, 400);
  }

  try {
    const result = await refundRedemption(id, body.refundTxHash, admin.email);
    return c.json({ ok: true, ...result });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "Refund failed" },
      400,
    );
  }
});

export default adminRedemptions;
