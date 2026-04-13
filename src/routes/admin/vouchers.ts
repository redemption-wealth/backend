import { Hono } from "hono";
import { prisma } from "../../db.js";
import { requireOwner, type AuthEnv } from "../../middleware/auth.js";
import {
  createVoucherSchema,
  updateVoucherSchema,
} from "../../schemas/voucher.js";
import { generateQrTokensForVoucher } from "../../services/qr-generator.js";

const adminVouchers = new Hono<AuthEnv>();

// GET /api/admin/vouchers — List vouchers (merchant-scoped for admin role)
adminVouchers.get("/", async (c) => {
  const adminAuth = c.get("adminAuth");
  const merchantIdQuery = c.req.query("merchantId");
  const search = c.req.query("search");
  const page = parseInt(c.req.query("page") ?? "1");
  const limit = parseInt(c.req.query("limit") ?? "20");

  // Admin role sees only their merchant's vouchers
  const merchantIdFilter =
    adminAuth.role === "admin"
      ? adminAuth.merchantId
      : merchantIdQuery || undefined;

  const where = {
    ...(merchantIdFilter && { merchantId: merchantIdFilter }),
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

  // Calculate stock breakdown (QR pool status)
  const vouchersWithStock = vouchersList.map((v) => {
    const availableQrCount = v._count.qrCodes;
    const availableStock = Math.floor(availableQrCount / v.qrPerRedemption);

    const totalQrCodes = v.totalStock * v.qrPerRedemption;
    const usedQrCodes = v.usedStock * v.qrPerRedemption;
    const assignedQrCount = totalQrCodes - usedQrCodes - availableQrCount;
    const assignedStock = Math.floor(assignedQrCount / v.qrPerRedemption);

    return {
      ...v,
      availableStock,
      assignedStock,
      usedStock: v.usedStock,
      totalStock: v.totalStock,
      qrPoolStatus: {
        availableQr: availableQrCount,
        assignedQr: assignedQrCount,
        usedQr: usedQrCodes,
        totalQr: totalQrCodes,
      },
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

// GET /api/admin/vouchers/:id — Get voucher detail
adminVouchers.get("/:id", async (c) => {
  const id = c.req.param("id");
  const adminAuth = c.get("adminAuth");

  const voucher = await prisma.voucher.findUnique({
    where: { id },
    include: { merchant: true },
  });

  if (!voucher) {
    return c.json({ error: "Voucher not found" }, 404);
  }

  // Admin role: enforce merchant ownership
  if (adminAuth.role === "admin" && voucher.merchantId !== adminAuth.merchantId) {
    return c.json({ error: "Access denied" }, 403);
  }

  return c.json({ voucher });
});

// POST /api/admin/vouchers — Create voucher
adminVouchers.post("/", async (c) => {
  const adminAuth = c.get("adminAuth");
  const body = await c.req.json();

  const parsed = createVoucherSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      400
    );
  }

  // Admin role: force merchantId to their own merchant
  const merchantId =
    adminAuth.role === "admin" ? adminAuth.merchantId! : parsed.data.merchantId;

  const { title, description, startDate, endDate, totalStock, priceIdr, qrPerRedemption } =
    parsed.data;

  // Calculate total QR codes needed
  const totalQrCodes = totalStock * qrPerRedemption;

  // Create voucher
  const voucher = await prisma.voucher.create({
    data: {
      merchantId,
      title,
      description,
      startDate: new Date(startDate),
      endDate: new Date(endDate),
      totalStock,
      remainingStock: totalStock,
      priceIdr,
      qrPerRedemption,
    },
  });

  // Generate QR tokens (no images yet, just tokens)
  await generateQrTokensForVoucher(prisma, voucher.id, totalQrCodes);

  return c.json({ voucher, qrCodesGenerated: totalQrCodes }, 201);
});

// PUT /api/admin/vouchers/:id — Update voucher
adminVouchers.put("/:id", async (c) => {
  const id = c.req.param("id");
  const adminAuth = c.get("adminAuth");
  const body = await c.req.json();

  // Fetch existing voucher
  const voucher = await prisma.voucher.findUnique({ where: { id } });
  if (!voucher) return c.json({ error: "Voucher not found" }, 404);

  // Admin role: check ownership before update
  if (adminAuth.role === "admin" && voucher.merchantId !== adminAuth.merchantId) {
    return c.json({ error: "Access denied" }, 403);
  }

  const parsed = updateVoucherSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      400
    );
  }

  // Handle stock changes
  if (parsed.data.totalStock !== undefined && parsed.data.totalStock !== voucher.totalStock) {
    const oldStock = voucher.totalStock;
    const newStock = parsed.data.totalStock;
    const qrPerRedemption = voucher.qrPerRedemption; // Immutable after creation

    const oldQrCount = oldStock * qrPerRedemption;
    const newQrCount = newStock * qrPerRedemption;

    if (newQrCount > oldQrCount) {
      // INCREASE: Generate additional QR codes
      const additionalQr = newQrCount - oldQrCount;
      await generateQrTokensForVoucher(prisma, voucher.id, additionalQr);

    } else if (newQrCount < oldQrCount) {
      // DECREASE: Validate available QR count
      const excessQr = oldQrCount - newQrCount;

      const availableQrCount = await prisma.qrCode.count({
        where: { voucherId: voucher.id, status: "available" }
      });

      if (availableQrCount < excessQr) {
        return c.json({
          error: `Cannot reduce stock. Only ${availableQrCount} available QR codes. ` +
                 `Need to remove ${excessQr}. Wait for pending redemptions to complete.`
        }, 400);
      }

      // Delete excess available QR codes (FIFO)
      const qrsToDelete = await prisma.qrCode.findMany({
        where: { voucherId: voucher.id, status: "available" },
        orderBy: { createdAt: "asc" },
        take: excessQr,
        select: { id: true },
      });

      await prisma.qrCode.deleteMany({
        where: { id: { in: qrsToDelete.map(q => q.id) } }
      });
    }
  }

  // Update voucher
  const data = { ...parsed.data } as Record<string, unknown>;
  if (data.startDate) data.startDate = new Date(data.startDate as string);
  if (data.endDate) data.endDate = new Date(data.endDate as string);

  try {
    const updated = await prisma.voucher.update({ where: { id }, data });
    return c.json({ voucher: updated });
  } catch {
    return c.json({ error: "Voucher not found" }, 404);
  }
});

// DELETE /api/admin/vouchers/:id — Delete voucher (owner only)
adminVouchers.delete("/:id", requireOwner, async (c) => {
  const id = c.req.param("id");
  try {
    await prisma.voucher.delete({ where: { id } });
    return c.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("Foreign key constraint")) {
      return c.json(
        { error: "Cannot delete voucher with existing redemptions" },
        400
      );
    }
    return c.json({ error: "Voucher not found" }, 404);
  }
});

export default adminVouchers;
