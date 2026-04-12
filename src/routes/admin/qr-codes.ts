import { Hono } from "hono";
import { prisma } from "../../db.js";
import type { AuthEnv } from "../../middleware/auth.js";
import { createQrCodeSchema } from "../../schemas/qr-code.js";

const adminQrCodes = new Hono<AuthEnv>();

// GET /api/admin/qr-codes — List QR codes
adminQrCodes.get("/", async (c) => {
  const voucherId = c.req.query("voucherId");
  const status = c.req.query("status");
  const page = parseInt(c.req.query("page") ?? "1");
  const limit = parseInt(c.req.query("limit") ?? "50");

  const where = {
    ...(voucherId && { voucherId }),
    ...(status && { status: status as never }),
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

// POST /api/admin/qr-codes — Create QR code
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

// POST /api/admin/qr-codes/:id/mark-used — Mark QR as used
adminQrCodes.post("/:id/mark-used", async (c) => {
  const id = c.req.param("id");

  const qrCode = await prisma.qrCode.findUnique({ where: { id } });
  if (!qrCode) {
    return c.json({ error: "QR code not found" }, 404);
  }

  if (qrCode.status !== "assigned") {
    return c.json(
      { error: "QR code must be in 'assigned' status to mark as used" },
      400
    );
  }

  const updated = await prisma.qrCode.update({
    where: { id },
    data: { status: "used", usedAt: new Date() },
  });

  return c.json({ qrCode: updated });
});

export default adminQrCodes;
