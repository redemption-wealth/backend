import { Hono } from "hono";
import { Prisma } from "@prisma/client";
import { prisma } from "../../db.js";
import { requireOwner, type AuthEnv } from "../../middleware/auth.js";
import {
  createVoucherSchema,
  updateVoucherSchema,
} from "../../schemas/voucher.js";
import { calcTotalPrice } from "../../services/pricing.js";
import { randomUUID } from "crypto";

const adminVouchers = new Hono<AuthEnv>();

// Soft delete helper
const notDeleted = { deletedAt: null };

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
    ...notDeleted,
    ...(merchantIdFilter && { merchantId: merchantIdFilter }),
    ...(search && {
      title: { contains: search, mode: "insensitive" as const },
    }),
  };

  const [vouchersList, total] = await Promise.all([
    prisma.voucher.findMany({
      where,
      include: { merchant: true },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.voucher.count({ where }),
  ]);

  return c.json({
    vouchers: vouchersList,
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

  if (!voucher || voucher.deletedAt) {
    return c.json({ error: "Voucher not found" }, 404);
  }

  // Admin role: enforce merchant ownership
  if (adminAuth.role === "admin" && voucher.merchantId !== adminAuth.merchantId) {
    return c.json({ error: "Access denied" }, 403);
  }

  return c.json({ voucher });
});

// POST /api/admin/vouchers — Create voucher with atomic slot + QR generation
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

  const { title, description, startDate, expiryDate, totalStock, basePrice, qrPerSlot } =
    parsed.data;

  // 1. Fetch system config for app fee rate
  const systemConfig = await prisma.appSettings.findUnique({
    where: { id: "singleton" },
  });
  const appFeeRate = systemConfig?.appFeeRate
    ? new Prisma.Decimal(systemConfig.appFeeRate.toString())
    : new Prisma.Decimal("3.00");

  // 2. Fetch active fee setting
  const activeFee = await prisma.feeSetting.findFirst({
    where: { isActive: true },
  });
  if (!activeFee) {
    return c.json(
      { error: "No active fee setting found", code: "NO_ACTIVE_FEE" },
      422
    );
  }
  const gasFeeAmount = new Prisma.Decimal(activeFee.amountIdr.toString());

  // 3. Calculate total price
  const basePriceDecimal = new Prisma.Decimal(basePrice.toString());
  const totalPrice = calcTotalPrice(basePriceDecimal, appFeeRate, gasFeeAmount);

  // 4. Generate slots and QR data arrays
  const slots = Array.from({ length: totalStock }, (_, i) => ({
    id: randomUUID(),
    slotIndex: i + 1,
  }));

  const qrCodes: Array<{
    id: string;
    slotId: string;
    qrNumber: number;
    imageUrl: string;
    imageHash: string;
  }> = [];

  for (const slot of slots) {
    for (let qrNum = 1; qrNum <= qrPerSlot; qrNum++) {
      const qrId = randomUUID();
      qrCodes.push({
        id: qrId,
        slotId: slot.id,
        qrNumber: qrNum,
        imageUrl: `https://placeholder.qr/${qrId}`, // TODO: generate actual QR images
        imageHash: `hash_${qrId}`, // TODO: generate actual hash
      });
    }
  }

  // 5. Atomic transaction: create voucher + slots + QR codes
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
        appFeeRate,
        gasFeeAmount,
        totalPrice,
        qrPerSlot,
        createdBy: adminAuth.adminId,
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
        imageUrl: qr.imageUrl,
        imageHash: qr.imageHash,
      })),
    });

    return {
      voucher,
      slotsCreated: slots.length,
      qrCodesCreated: qrCodes.length,
    };
  });

  return c.json(result, 201);
});

// PUT /api/admin/vouchers/:id — Update voucher with stock management
adminVouchers.put("/:id", async (c) => {
  const id = c.req.param("id");
  const adminAuth = c.get("adminAuth");
  const body = await c.req.json();

  // Admin role: check ownership before update
  const existing = await prisma.voucher.findUnique({
    where: { id },
    select: { merchantId: true, totalStock: true, qrPerSlot: true, deletedAt: true },
  });

  if (!existing || existing.deletedAt) {
    return c.json({ error: "Voucher not found" }, 404);
  }

  if (adminAuth.role === "admin" && existing.merchantId !== adminAuth.merchantId) {
    return c.json({ error: "Access denied" }, 403);
  }

  const parsed = updateVoucherSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      400
    );
  }

  const data = { ...parsed.data } as Record<string, unknown>;
  if (data.startDate) data.startDate = new Date(data.startDate as string);
  if (data.expiryDate) data.expiryDate = new Date(data.expiryDate as string);

  // Handle totalStock updates with floor constraint and slot management
  const newTotalStock = parsed.data.totalStock;

  if (newTotalStock !== undefined && newTotalStock !== existing.totalStock) {
    const floor = await prisma.redemptionSlot.count({
      where: {
        voucherId: id,
        status: { in: ["redeemed", "fully_used"] },
      },
    });

    if (newTotalStock < floor) {
      return c.json(
        {
          error: "Cannot reduce stock below floor",
          code: "BELOW_FLOOR",
          floor,
          requested: newTotalStock
        },
        422
      );
    }

    // Perform stock update in transaction
    const result = await prisma.$transaction(async (tx) => {
      if (newTotalStock > existing.totalStock) {
        // Increasing stock: generate new slots and QR codes
        const newSlots = Array.from(
          { length: newTotalStock - existing.totalStock },
          (_, i) => ({
            id: randomUUID(),
            slotIndex: existing.totalStock + i + 1,
          })
        );

        const newQrCodes: Array<{
          id: string;
          slotId: string;
          qrNumber: number;
          imageUrl: string;
          imageHash: string;
        }> = [];

        for (const slot of newSlots) {
          for (let qrNum = 1; qrNum <= existing.qrPerSlot; qrNum++) {
            const qrId = randomUUID();
            newQrCodes.push({
              id: qrId,
              slotId: slot.id,
              qrNumber: qrNum,
              imageUrl: `https://placeholder.qr/${qrId}`,
              imageHash: `hash_${qrId}`,
            });
          }
        }

        await tx.redemptionSlot.createMany({
          data: newSlots.map((slot) => ({
            id: slot.id,
            voucherId: id,
            slotIndex: slot.slotIndex,
          })),
        });

        await tx.qrCode.createMany({
          data: newQrCodes.map((qr) => ({
            id: qr.id,
            voucherId: id,
            slotId: qr.slotId,
            qrNumber: qr.qrNumber,
            imageUrl: qr.imageUrl,
            imageHash: qr.imageHash,
          })),
        });
      } else if (newTotalStock < existing.totalStock) {
        // Decreasing stock: delete available slots from the end
        const slotsToDelete = await tx.redemptionSlot.findMany({
          where: {
            voucherId: id,
            status: "available",
            slotIndex: { gt: newTotalStock },
          },
          select: { id: true },
          orderBy: { slotIndex: "desc" },
        });

        const slotIds = slotsToDelete.map((s) => s.id);

        // Delete QR codes for these slots
        await tx.qrCode.deleteMany({
          where: { slotId: { in: slotIds } },
        });

        // Delete the slots
        await tx.redemptionSlot.deleteMany({
          where: { id: { in: slotIds } },
        });
      }

      // Recalculate remainingStock
      const availableCount = await tx.redemptionSlot.count({
        where: { voucherId: id, status: "available" },
      });

      // Update voucher with new data
      const voucher = await tx.voucher.update({
        where: { id },
        data: {
          ...data,
          totalStock: newTotalStock,
          remainingStock: availableCount,
        },
      });

      return voucher;
    });

    return c.json({ voucher: result });
  }

  // No stock update, just update other fields
  try {
    const voucher = await prisma.voucher.update({ where: { id }, data });
    return c.json({ voucher });
  } catch {
    return c.json({ error: "Voucher not found" }, 404);
  }
});

// DELETE /api/admin/vouchers/:id — Soft delete voucher (manager + admin scoped)
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

  // Permission check: manager can always delete, admin must own merchant
  if (adminAuth.role === "admin" && voucher.merchantId !== adminAuth.merchantId) {
    return c.json({ error: "Access denied" }, 403);
  }

  // Check for active QR codes (redeemed or used)
  const activeQrCount = await prisma.qrCode.count({
    where: {
      voucherId: id,
      status: { in: ["redeemed", "used"] },
    },
  });

  if (activeQrCount > 0) {
    return c.json(
      { error: "Cannot delete voucher with active QR codes", code: "VOUCHER_HAS_ACTIVE_QR" },
      422
    );
  }

  try {
    await prisma.voucher.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    return c.json({ ok: true });
  } catch {
    return c.json({ error: "Voucher not found" }, 404);
  }
});

// POST /api/admin/vouchers/recalculate-stock — Recalculate remainingStock for all vouchers
adminVouchers.post("/recalculate-stock", requireOwner, async (c) => {
  const vouchers = await prisma.voucher.findMany({
    where: notDeleted,
    select: { id: true, remainingStock: true },
  });

  let fixed = 0;
  for (const v of vouchers) {
    const availableCount = await prisma.redemptionSlot.count({
      where: { voucherId: v.id, status: "available" },
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
