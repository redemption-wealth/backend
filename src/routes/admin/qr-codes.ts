import { Hono } from "hono";
import { prisma } from "../../db.js";
import { requireAdminRole, requireManagerOrAdmin, type AuthEnv } from "../../middleware/auth.js";
import { qrScanLimiter } from "../../middleware/rate-limit.js";
import { createQrCodeSchema, scanQrSchema } from "../../schemas/qr-code.js";

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

  const { id } = parsed.data;

  const qrCode = await prisma.qrCode.findUnique({
    where: { id },
    include: {
      voucher: {
        select: {
          id: true,
          title: true,
          merchantId: true,
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

  // Status checks
  if (qrCode.status === "AVAILABLE") {
    return c.json({ error: "QR_NOT_REDEEMED", code: "QR_NOT_REDEEMED" }, 422);
  }
  if (qrCode.status === "USED") {
    return c.json({ error: "ALREADY_USED", code: "QR_ALREADY_USED" }, 409);
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
  const page = parseInt(c.req.query("page") ?? "1");
  const limit = parseInt(c.req.query("limit") ?? "50");

  const where = {
    ...(voucherId && { voucherId }),
    ...(status && { status: status as never }),
    ...(adminAuth.role === "ADMIN" && adminAuth.merchantId && {
      voucher: { merchantId: adminAuth.merchantId },
    }),
  };

  const [qrCodes, total] = await Promise.all([
    prisma.qrCode.findMany({
      where,
      include: {
        voucher: { select: { title: true, merchant: { select: { name: true } } } },
        scannedBy: { select: { user: { select: { email: true } } } },
      },
      orderBy: { createdAt: "desc" },
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

// POST /api/admin/qr-codes — Create QR code (manual, for legacy/testing)
adminQrCodes.post("/", async (c) => {
  const body = await c.req.json();

  const parsed = createQrCodeSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
  }

  try {
    const qrCode = await prisma.qrCode.create({ data: parsed.data });
    return c.json({ qrCode }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("Unique constraint")) {
      return c.json({ error: "Duplicate imageHash" }, 409);
    }
    return c.json({ error: "Failed to create QR code" }, 400);
  }
});

export default adminQrCodes;
