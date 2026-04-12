import { Hono } from "hono";
import { prisma } from "../../db.js";
import type { AuthEnv } from "../../middleware/auth.js";

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
  const { voucherId, imageUrl, imageHash } = await c.req.json();

  const qrCode = await prisma.qrCode.create({
    data: { voucherId, imageUrl, imageHash },
  });

  return c.json({ qrCode }, 201);
});

// POST /api/admin/qr-codes/:id/mark-used — Mark QR as used
adminQrCodes.post("/:id/mark-used", async (c) => {
  const id = c.req.param("id");

  const qrCode = await prisma.qrCode.update({
    where: { id },
    data: { status: "used", usedAt: new Date() },
  });

  return c.json({ qrCode });
});

export default adminQrCodes;
