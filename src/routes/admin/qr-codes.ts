import { Hono } from "hono";
import { Prisma } from "@prisma/client";
import { prisma } from "../../db.js";
import { requireAdminRole, requireManagerOrAdmin, type AuthEnv } from "../../middleware/auth.js";
import { qrScanLimiter } from "../../middleware/rate-limit.js";
import { scanQrSchema } from "../../schemas/qr-code.js";
import { parseSort, buildOrderBy } from "../../lib/list-query.js";

const adminQrCodes = new Hono<AuthEnv>();

// GET /api/admin/qr-codes/counts — Count QR codes by status (manager: all; admin: scoped to merchant)
// Must be registered before any /:id handler
adminQrCodes.get("/counts", requireManagerOrAdmin, async (c) => {
  const adminAuth = c.get("adminAuth");

  const merchantFilter =
    adminAuth.role === "ADMIN" && adminAuth.merchantId
      ? { voucher: { merchantId: adminAuth.merchantId } }
      : {};

  const [available, redeemed, used] = await Promise.all([
    prisma.qrCode.count({ where: { status: "AVAILABLE", ...merchantFilter } }),
    prisma.qrCode.count({ where: { status: "REDEEMED", ...merchantFilter } }),
    prisma.qrCode.count({ where: { status: "USED", ...merchantFilter } }),
  ]);

  return c.json({ available, redeemed, used });
});

// POST /api/admin/qr-codes/scan — Scan a QR code with slot completion logic
adminQrCodes.post("/scan", requireAdminRole, qrScanLimiter, async (c) => {
  const adminAuth = c.get("adminAuth");
  const body = await c.req.json();

  const parsed = scanQrSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
  }

  const { token } = parsed.data;

  const qrCode = await prisma.qrCode.findUnique({
    where: { token },
    include: {
      voucher: {
        select: {
          id: true,
          title: true,
          merchantId: true,
          assetSource: true,
          isActive: true,
          startDate: true,
          expiryDate: true,
          merchant: { select: { name: true } },
        },
      },
    },
  });

  if (!qrCode) {
    return c.json({ error: "NOT_FOUND" }, 404);
  }

  // Admin role: enforce merchant ownership
  if (adminAuth.role === "ADMIN" && qrCode.voucher.merchantId !== adminAuth.merchantId) {
    return c.json({ error: "WRONG_MERCHANT" }, 403);
  }

  // Merchant-uploaded assets are verified on the merchant's own system, not via
  // the Wealth back-office scanner — reject so the scan→USED stock flow (which
  // decrements stock) can never run for them.
  if (qrCode.voucher.assetSource === "MERCHANT_UPLOADED") {
    return c.json(
      {
        error: "SCAN_NOT_SUPPORTED",
        code: "SCAN_NOT_SUPPORTED",
        voucherTitle: qrCode.voucher.title,
        merchantName: qrCode.voucher.merchant.name,
      },
      422,
    );
  }

  // Status checks
  if (qrCode.status === "AVAILABLE") {
    return c.json({ error: "QR_NOT_REDEEMED", code: "QR_NOT_REDEEMED" }, 422);
  }
  if (qrCode.status === "USED") {
    return c.json({ error: "ALREADY_USED", code: "QR_ALREADY_USED" }, 409);
  }

  // Voucher validity: a redeemed QR must be honored only while its voucher is
  // active and within its masa berlaku (validity window, WIB, UTC+7). Reject a
  // not-yet-started or expired/deactivated voucher so a QR can't be used at the
  // counter outside the promo window.
  const now = new Date();
  const startDay = new Date(qrCode.voucher.startDate);
  startDay.setUTCHours(-7, 0, 0, 0); // 00:00 WIB = 17:00 UTC previous day
  const expiryEnd = new Date(qrCode.voucher.expiryDate);
  expiryEnd.setUTCHours(16, 59, 59, 999); // 23:59:59 WIB = 16:59:59 UTC
  if (startDay > now) {
    return c.json(
      {
        error: "VOUCHER_NOT_STARTED",
        code: "VOUCHER_NOT_STARTED",
        voucherTitle: qrCode.voucher.title,
        merchantName: qrCode.voucher.merchant.name,
      },
      422,
    );
  }
  if (!qrCode.voucher.isActive || expiryEnd < now) {
    return c.json(
      {
        error: "VOUCHER_EXPIRED",
        code: "VOUCHER_EXPIRED",
        voucherTitle: qrCode.voucher.title,
        merchantName: qrCode.voucher.merchant.name,
      },
      422,
    );
  }

  if (qrCode.status !== "REDEEMED") {
    return c.json({ error: "Invalid QR status" }, 422);
  }

  // Atomic transaction: mark QR as used, check slot completion
  const result = await prisma.$transaction(async (tx) => {
    await tx.qrCode.update({
      where: { id: qrCode.id },
      data: {
        status: "USED",
        usedAt: new Date(),
        scannedById: adminAuth.adminId,
      },
    });

    const unusedCount = await tx.qrCode.count({
      where: {
        slotId: qrCode.slotId,
        status: { not: "USED" },
      },
    });

    if (unusedCount === 0) {
      await tx.redemptionSlot.update({
        where: { id: qrCode.slotId },
        data: { status: "FULLY_USED" },
      });

      await tx.voucher.update({
        where: { id: qrCode.voucherId },
        data: { remainingStock: { decrement: 1 } },
      });
    }

    return { slotCompleted: unusedCount === 0 };
  });

  return c.json({
    success: true,
    voucherId: qrCode.voucherId,
    voucherTitle: qrCode.voucher.title,
    merchantName: qrCode.voucher.merchant.name,
    usedAt: new Date(),
    scannedByAdminId: adminAuth.adminId,
    slotCompleted: result.slotCompleted,
  });
});

// GET /api/admin/qr-codes — List QR codes (merchant-scoped for ADMIN role)
adminQrCodes.get("/", async (c) => {
  const adminAuth = c.get("adminAuth");
  const voucherId = c.req.query("voucherId");
  const status = c.req.query("status");
  const search = c.req.query("search")?.trim();
  const page = parseInt(c.req.query("page") ?? "1");
  const limit = parseInt(c.req.query("limit") ?? "50");

  // Free-text search across every meaningful column: QR id/token, voucher
  // title, merchant name, the admin who scanned it — and the status enum when
  // the term is typed exactly (e.g. "used"). Kept as a top-level OR (not under
  // `voucher`) so it doesn't clash with the ADMIN merchant-scope filter.
  const statusMatch = search
    ? (["AVAILABLE", "REDEEMED", "USED"] as const).find(
        (s) => s === search.toUpperCase(),
      )
    : undefined;

  const where: Prisma.QrCodeWhereInput = {
    ...(voucherId && { voucherId }),
    ...(status && { status: status as never }),
    ...(adminAuth.role === "ADMIN" && adminAuth.merchantId && {
      voucher: { merchantId: adminAuth.merchantId },
    }),
    ...(search && {
      OR: [
        { id: { contains: search, mode: "insensitive" } },
        { token: { contains: search, mode: "insensitive" } },
        { voucher: { title: { contains: search, mode: "insensitive" } } },
        { voucher: { merchant: { name: { contains: search, mode: "insensitive" } } } },
        { scannedBy: { user: { email: { contains: search, mode: "insensitive" } } } },
        ...(statusMatch ? [{ status: statusMatch }] : []),
      ],
    }),
  };

  const orderBy = buildOrderBy<Prisma.QrCodeOrderByWithRelationInput>(
    parseSort(c),
    {
      status: (dir) => ({ status: dir }),
      assignedAt: (dir) => ({ assignedAt: dir }),
      usedAt: (dir) => ({ usedAt: dir }),
      qrNumber: (dir) => ({ qrNumber: dir }),
      voucher: (dir) => ({ voucher: { title: dir } }),
      createdAt: (dir) => ({ createdAt: dir }),
    },
    (dir) => ({ createdAt: dir }),
  );

  const [qrCodes, total] = await Promise.all([
    prisma.qrCode.findMany({
      where,
      include: {
        voucher: { select: { title: true, merchant: { select: { name: true } } } },
        scannedBy: { select: { user: { select: { email: true } } } },
      },
      orderBy,
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.qrCode.count({ where }),
  ]);

  return c.json({
    qrCodes,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
});


export default adminQrCodes;
