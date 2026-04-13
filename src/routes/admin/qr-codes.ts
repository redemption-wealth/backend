import { Hono } from "hono";
import { prisma } from "../../db.js";
import type { AuthEnv } from "../../middleware/auth.js";
import { qrScanLimiter } from "../../middleware/rate-limit.js";
import { createQrCodeSchema, scanQrSchema } from "../../schemas/qr-code.js";

const adminQrCodes = new Hono<AuthEnv>();

// POST /api/admin/qr-codes/scan — Scan a QR token (must be before /:id routes)
adminQrCodes.post("/scan", qrScanLimiter, async (c) => {
  const adminAuth = c.get("adminAuth");
  const body = await c.req.json();

  const parsed = scanQrSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
  }

  const { token } = parsed.data;

  // Find QR by token, include voucher merchantId for ownership check
  const qrCode = await prisma.qrCode.findUnique({
    where: { token },
    include: { voucher: { select: { merchantId: true } } },
  });

  if (!qrCode) {
    return c.json({ error: "NOT_FOUND" }, 404);
  }

  // Admin role: enforce merchant ownership
  if (adminAuth.role === "admin" && qrCode.voucher.merchantId !== adminAuth.merchantId) {
    return c.json({ error: "WRONG_MERCHANT" }, 403);
  }

  // Atomic update: only succeeds if status is currently 'assigned'
  const updated = await prisma.qrCode.updateMany({
    where: { id: qrCode.id, status: "assigned" },
    data: {
      status: "used",
      usedAt: new Date(),
      scannedByAdminId: adminAuth.adminId,
    },
  });

  if (updated.count === 0) {
    // Re-fetch to determine current status
    const current = await prisma.qrCode.findUnique({
      where: { id: qrCode.id },
      select: { status: true },
    });
    if (current?.status === "used") {
      return c.json({ error: "ALREADY_USED" }, 409);
    }
    return c.json({ error: "QR code is not in assignable state" }, 422);
  }

  return c.json({
    success: true,
    voucherId: qrCode.voucherId,
    usedAt: new Date(),
    scannedByAdminId: adminAuth.adminId,
  });
});

// GET /api/admin/qr-codes — List QR codes (merchant-scoped for admin role)
adminQrCodes.get("/", async (c) => {
  const adminAuth = c.get("adminAuth");
  const voucherId = c.req.query("voucherId");
  const status = c.req.query("status");
  const page = parseInt(c.req.query("page") ?? "1");
  const limit = parseInt(c.req.query("limit") ?? "50");

  const where = {
    ...(voucherId && { voucherId }),
    ...(status && { status: status as never }),
    ...(adminAuth.role === "admin" && adminAuth.merchantId && {
      voucher: { merchantId: adminAuth.merchantId },
    }),
  };

  const [qrCodes, total] = await Promise.all([
    prisma.qrCode.findMany({
      where,
      include: {
        voucher: {
          select: { title: true, merchant: { select: { name: true } } },
        },
        assignedTo: { select: { email: true } },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.qrCode.count({ where }),
  ]);

  return c.json({
    qrCodes,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  });
});

// POST /api/admin/qr-codes — Create QR code (manual, for legacy/testing)
adminQrCodes.post("/", async (c) => {
  const body = await c.req.json();

  const parsed = createQrCodeSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      400
    );
  }

  try {
    const qrCode = await prisma.qrCode.create({
      data: parsed.data,
    });
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
