import { Hono } from "hono";
import { Prisma } from "@prisma/client";
import { prisma } from "../../db.js";
import { requireOwner, requireManagerOrAdmin, type AuthEnv } from "../../middleware/auth.js";
import {
  createVoucherSchema,
  updateVoucherSchema,
} from "../../schemas/voucher.js";
import { getLiveFeeConfig, injectFeeFields } from "../../services/pricing.js";
import { randomUUID } from "crypto";

const adminVouchers = new Hono<AuthEnv>();

const notDeleted = { deletedAt: null };

// GET /api/admin/vouchers — List vouchers (merchant-scoped for ADMIN role)
adminVouchers.get("/", async (c) => {
  const adminAuth = c.get("adminAuth");
  const merchantIdQuery = c.req.query("merchantId");
  const search = c.req.query("search");
  const page = parseInt(c.req.query("page") ?? "1");
  const limit = parseInt(c.req.query("limit") ?? "20");

  const merchantIdFilter =
    adminAuth.role === "ADMIN"
      ? adminAuth.merchantId
      : merchantIdQuery || undefined;

  const where = {
    ...notDeleted,
    ...(merchantIdFilter && { merchantId: merchantIdFilter }),
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

// GET /api/admin/vouchers/:id — Get voucher detail
adminVouchers.get("/:id", async (c) => {
  const id = c.req.param("id");
  const adminAuth = c.get("adminAuth");

  const voucher = await prisma.voucher.findUnique({
    where: { id },
    include: { merchant: true },
  });

  if (!voucher || voucher.deletedAt) {
    return c.json({ error: "Voucher not found" }, 404);
  }

  if (adminAuth.role === "ADMIN" && voucher.merchantId !== adminAuth.merchantId) {
    return c.json({ error: "Access denied" }, 403);
  }

  const { appFeeRate, gasFeeAmount } = await getLiveFeeConfig();
  return c.json({ voucher: injectFeeFields(voucher, appFeeRate, gasFeeAmount) });
});

// POST /api/admin/vouchers — Create voucher with atomic slot + QR generation
adminVouchers.post("/", async (c) => {
  const adminAuth = c.get("adminAuth");
  const body = await c.req.json();

  const parsed = createVoucherSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
  }

  const merchantId =
    adminAuth.role === "ADMIN" ? adminAuth.merchantId! : parsed.data.merchantId;

  const { title, description, startDate, expiryDate, totalStock, basePrice, qrPerSlot } =
    parsed.data;

  const basePriceDecimal = new Prisma.Decimal(basePrice.toString());

  const { appFeeRate, gasFeeAmount } = await getLiveFeeConfig();

  const slots = Array.from({ length: totalStock }, (_, i) => ({
    id: randomUUID(),
    slotIndex: i + 1,
  }));

  const qrCodes: Array<{
    id: string;
    slotId: string;
    qrNumber: number;
    imageHash: string;
  }> = [];

  for (const slot of slots) {
    for (let qrNum = 1; qrNum <= qrPerSlot; qrNum++) {
      const qrId = randomUUID();
      qrCodes.push({
        id: qrId,
        slotId: slot.id,
        qrNumber: qrNum,
        imageHash: `pending_${qrId}`,
      });
    }
  }

  const result = await prisma.$transaction(async (tx) => {
    const voucher = await tx.voucher.create({
      data: {
        merchantId,
        title,
        description,
        startDate: new Date(startDate),
        expiryDate: new Date(expiryDate),
        totalStock,
        remainingStock: totalStock,
        basePrice: basePriceDecimal,
        qrPerSlot,
        appFeeSnapshot: appFeeRate,
        gasFeeSnapshot: gasFeeAmount,
      },
    });

    await tx.redemptionSlot.createMany({
      data: slots.map((slot) => ({
        id: slot.id,
        voucherId: voucher.id,
        slotIndex: slot.slotIndex,
      })),
    });

    await tx.qrCode.createMany({
      data: qrCodes.map((qr) => ({
        id: qr.id,
        voucherId: voucher.id,
        slotId: qr.slotId,
        qrNumber: qr.qrNumber,
        imageHash: qr.imageHash,
      })),
    });

    return { voucher, slotsCreated: slots.length, qrCodesCreated: qrCodes.length };
  });

  return c.json({
    ...result,
    voucher: injectFeeFields(result.voucher, appFeeRate, gasFeeAmount),
  }, 201);
});

// PUT /api/admin/vouchers/:id — Update voucher with stock management
adminVouchers.put("/:id", async (c) => {
  const id = c.req.param("id");
  const adminAuth = c.get("adminAuth");
  const body = await c.req.json();

  const existing = await prisma.voucher.findUnique({
    where: { id },
    select: { merchantId: true, totalStock: true, qrPerSlot: true, deletedAt: true },
  });

  if (!existing || existing.deletedAt) {
    return c.json({ error: "Voucher not found" }, 404);
  }

  if (adminAuth.role === "ADMIN" && existing.merchantId !== adminAuth.merchantId) {
    return c.json({ error: "Access denied" }, 403);
  }

  const parsed = updateVoucherSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
  }

  const data = { ...parsed.data } as Record<string, unknown>;
  if (data.startDate) data.startDate = new Date(data.startDate as string);
  if (data.expiryDate) data.expiryDate = new Date(data.expiryDate as string);

  const newTotalStock = parsed.data.totalStock;

  if (newTotalStock !== undefined && newTotalStock !== existing.totalStock) {
    const floor = await prisma.redemptionSlot.count({
      where: {
        voucherId: id,
        status: { in: ["REDEEMED", "FULLY_USED"] },
      },
    });

    if (newTotalStock < floor) {
      return c.json(
        { error: "Cannot reduce stock below floor", code: "BELOW_FLOOR", floor, requested: newTotalStock },
        422
      );
    }

    const result = await prisma.$transaction(async (tx) => {
      if (newTotalStock > existing.totalStock) {
        const newSlots = Array.from(
          { length: newTotalStock - existing.totalStock },
          (_, i) => ({ id: randomUUID(), slotIndex: existing.totalStock + i + 1 })
        );

        const newQrCodes: Array<{
          id: string; slotId: string; qrNumber: number; imageHash: string;
        }> = [];

        for (const slot of newSlots) {
          for (let qrNum = 1; qrNum <= existing.qrPerSlot; qrNum++) {
            const qrId = randomUUID();
            newQrCodes.push({
              id: qrId,
              slotId: slot.id,
              qrNumber: qrNum,
              imageHash: `pending_${qrId}`,
            });
          }
        }

        await tx.redemptionSlot.createMany({
          data: newSlots.map((slot) => ({ id: slot.id, voucherId: id, slotIndex: slot.slotIndex })),
        });

        await tx.qrCode.createMany({
          data: newQrCodes.map((qr) => ({
            id: qr.id, voucherId: id, slotId: qr.slotId, qrNumber: qr.qrNumber,
            imageHash: qr.imageHash,
          })),
        });
      } else if (newTotalStock < existing.totalStock) {
        const slotsToDelete = await tx.redemptionSlot.findMany({
          where: { voucherId: id, status: "AVAILABLE", slotIndex: { gt: newTotalStock } },
          select: { id: true },
          orderBy: { slotIndex: "desc" },
        });

        const slotIds = slotsToDelete.map((s) => s.id);
        await tx.qrCode.deleteMany({ where: { slotId: { in: slotIds } } });
        await tx.redemptionSlot.deleteMany({ where: { id: { in: slotIds } } });
      }

      const availableCount = await tx.redemptionSlot.count({
        where: { voucherId: id, status: "AVAILABLE" },
      });

      return tx.voucher.update({
        where: { id },
        data: { ...data, totalStock: newTotalStock, remainingStock: availableCount },
      });
    });

    const { appFeeRate, gasFeeAmount } = await getLiveFeeConfig();
    return c.json({ voucher: injectFeeFields(result, appFeeRate, gasFeeAmount) });
  }

  try {
    const voucher = await prisma.voucher.update({ where: { id }, data });
    const { appFeeRate, gasFeeAmount } = await getLiveFeeConfig();
    return c.json({ voucher: injectFeeFields(voucher, appFeeRate, gasFeeAmount) });
  } catch {
    return c.json({ error: "Voucher not found" }, 404);
  }
});

// POST /api/admin/vouchers/:id/toggle-active — Toggle voucher active status (manager/admin scoped)
adminVouchers.post("/:id/toggle-active", requireManagerOrAdmin, async (c) => {
  const id = c.req.param("id");
  const adminAuth = c.get("adminAuth");

  const voucher = await prisma.voucher.findFirst({
    where: { id, deletedAt: null },
  });
  if (!voucher) return c.json({ error: "Voucher not found" }, 404);

  if (adminAuth.role === "ADMIN" && voucher.merchantId !== adminAuth.merchantId) {
    return c.json({ error: "Access denied" }, 403);
  }

  const updated = await prisma.voucher.update({
    where: { id },
    data: { isActive: !voucher.isActive },
  });
  return c.json({ voucher: updated });
});

// DELETE /api/admin/vouchers/:id — Soft delete
adminVouchers.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const adminAuth = c.get("adminAuth");

  const voucher = await prisma.voucher.findUnique({
    where: { id },
    select: { merchantId: true, deletedAt: true },
  });

  if (!voucher || voucher.deletedAt) {
    return c.json({ error: "Voucher not found" }, 404);
  }

  if (adminAuth.role === "ADMIN" && voucher.merchantId !== adminAuth.merchantId) {
    return c.json({ error: "Access denied" }, 403);
  }

  const activeQrCount = await prisma.qrCode.count({
    where: { voucherId: id, status: { in: ["REDEEMED", "USED"] } },
  });

  if (activeQrCount > 0) {
    return c.json(
      { error: "Cannot delete voucher with active QR codes", code: "VOUCHER_HAS_ACTIVE_QR" },
      422
    );
  }

  try {
    await prisma.voucher.update({ where: { id }, data: { deletedAt: new Date() } });
    return c.json({ ok: true });
  } catch {
    return c.json({ error: "Voucher not found" }, 404);
  }
});

// POST /api/admin/vouchers/recalculate-stock — Recalculate remainingStock (owner only)
adminVouchers.post("/recalculate-stock", requireOwner, async (c) => {
  const vouchers = await prisma.voucher.findMany({
    where: notDeleted,
    select: { id: true, remainingStock: true },
  });

  let fixed = 0;
  for (const v of vouchers) {
    const availableCount = await prisma.redemptionSlot.count({
      where: { voucherId: v.id, status: "AVAILABLE" },
    });

    if (v.remainingStock !== availableCount) {
      await prisma.voucher.update({
        where: { id: v.id },
        data: { remainingStock: availableCount },
      });
      fixed++;
    }
  }

  return c.json({ ok: true, total: vouchers.length, fixed });
});

export default adminVouchers;
