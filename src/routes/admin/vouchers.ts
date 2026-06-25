import { Hono } from "hono";
import { Prisma } from "@prisma/client";
import { prisma } from "../../db.js";
import { requireOwner, requireManagerOrAdmin, type AuthEnv } from "../../middleware/auth.js";
import {
  createVoucherSchema,
  updateVoucherSchema,
} from "../../schemas/voucher.js";
import { validateUploadedValues } from "../../services/asset-values.js";
import { getLiveFeeConfig, injectFeeFields } from "../../services/pricing.js";
import { parseSort, buildOrderBy } from "../../lib/list-query.js";
import { randomUUID, randomBytes } from "crypto";

const adminVouchers = new Hono<AuthEnv>();

const notDeleted = { deletedAt: null };

// Hard ceiling on QR rows materialized per voucher (totalStock × qrPerSlot).
// Creation pre-creates one slot + qrPerSlot QR rows per unit in a single
// transaction; beyond this the bulk insert risks exceeding the transaction
// timeout. 10k is far above any realistic merchant voucher.
const MAX_QR_PER_VOUCHER = 10_000;

// Midnight (UTC) of today's WIB calendar date — matches how @db.Date values are
// stored, so date-only comparisons for derived voucher status are correct.
function wibTodayUtcMidnight(): Date {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const [y, m, d] = fmt.format(new Date()).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

// Translate a derived voucher status into a Prisma where-clause. Priority mirrors
// deriveVoucherStatus() in the back-office (inactive → expired → upcoming →
// depleted → active) so server-side filtering and the client badge agree.
function voucherStatusWhere(status: string | undefined): Prisma.VoucherWhereInput {
  const today = wibTodayUtcMidnight();
  switch (status) {
    case "inactive":
      return { isActive: false };
    case "expired":
      return { isActive: true, expiryDate: { lt: today } };
    case "upcoming":
      return { isActive: true, startDate: { gt: today }, expiryDate: { gte: today } };
    case "depleted":
      return { isActive: true, startDate: { lte: today }, expiryDate: { gte: today }, remainingStock: { lte: 0 } };
    case "active":
      return { isActive: true, startDate: { lte: today }, expiryDate: { gte: today }, remainingStock: { gt: 0 } };
    default:
      return {};
  }
}

// GET /api/admin/vouchers — List vouchers (merchant-scoped for ADMIN role)
adminVouchers.get("/", async (c) => {
  const adminAuth = c.get("adminAuth");
  const merchantIdQuery = c.req.query("merchantId");
  const search = c.req.query("search");
  const status = c.req.query("status");
  const page = parseInt(c.req.query("page") ?? "1");
  const limit = parseInt(c.req.query("limit") ?? "20");

  const merchantIdFilter =
    adminAuth.role === "ADMIN"
      ? adminAuth.merchantId
      : merchantIdQuery || undefined;

  const where: Prisma.VoucherWhereInput = {
    ...notDeleted,
    ...(merchantIdFilter && { merchantId: merchantIdFilter }),
    ...(search && { title: { contains: search, mode: "insensitive" } }),
    ...voucherStatusWhere(status),
  };

  const orderBy = buildOrderBy<Prisma.VoucherOrderByWithRelationInput>(
    parseSort(c),
    {
      title: (dir) => ({ title: dir }),
      merchant: (dir) => ({ merchant: { name: dir } }),
      basePrice: (dir) => ({ basePrice: dir }),
      remainingStock: (dir) => ({ remainingStock: dir }),
      totalStock: (dir) => ({ totalStock: dir }),
      expiryDate: (dir) => ({ expiryDate: dir }),
      startDate: (dir) => ({ startDate: dir }),
      isActive: (dir) => ({ isActive: dir }),
      createdAt: (dir) => ({ createdAt: dir }),
    },
    (dir) => ({ createdAt: dir }),
  );

  const [vouchersList, total, feeConfig] = await Promise.all([
    prisma.voucher.findMany({
      where,
      include: { merchant: true },
      orderBy,
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

  const {
    title,
    description,
    startDate,
    expiryDate,
    totalStock,
    basePrice,
    qrPerSlot,
    format,
    assetSource,
    barcodeSymbology,
    values,
  } = parsed.data;

  if (totalStock * qrPerSlot > MAX_QR_PER_VOUCHER) {
    return c.json(
      {
        error: `Total QR (stok × QR per slot) melebihi batas maksimal ${MAX_QR_PER_VOUCHER.toLocaleString("id-ID")}. Kurangi stok atau QR per slot.`,
        code: "STOCK_LIMIT_EXCEEDED",
        max: MAX_QR_PER_VOUCHER,
        requested: totalStock * qrPerSlot,
      },
      422,
    );
  }

  // Merchant-uploaded vouchers: the supplied values must exactly fill every QR
  // slot, with no empties/duplicates and valid per-format/symbology content.
  // Wealth-generated vouchers carry no values (the schema already enforced that).
  if (assetSource === "MERCHANT_UPLOADED") {
    const validation = validateUploadedValues({
      format,
      symbology: barcodeSymbology ?? null,
      values: values ?? [],
      totalStock,
      qrPerSlot,
    });
    if (!validation.ok) {
      return c.json(
        {
          error: "Validasi nilai yang diupload gagal",
          code: "UPLOAD_VALIDATION_FAILED",
          details: validation.errors,
          expected: validation.expected,
          received: validation.received,
        },
        422,
      );
    }
  }

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
    token: string;
    value: string | null;
    imageUrl: string;
    imageHash: string;
  }> = [];

  for (const slot of slots) {
    for (let qrNum = 1; qrNum <= qrPerSlot; qrNum++) {
      const qrId = randomUUID();
      const token = randomBytes(16).toString("hex");
      // CSV row order: slot N, qr M → values[(N-1) * qrPerSlot + (M-1)].
      const value =
        assetSource === "MERCHANT_UPLOADED" && values
          ? (values[(slot.slotIndex - 1) * qrPerSlot + (qrNum - 1)] ?? "").trim()
          : null;
      qrCodes.push({
        id: qrId,
        slotId: slot.id,
        qrNumber: qrNum,
        token,
        value,
        imageUrl: `https://placeholder.qr/${qrId}`,
        imageHash: `hash_${qrId}`,
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
        format,
        assetSource,
        barcodeSymbology: format === "BARCODE" ? (barcodeSymbology ?? null) : null,
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
        token: qr.token,
        value: qr.value,
        imageUrl: qr.imageUrl,
        imageHash: qr.imageHash,
      })),
    });

    return { voucher, slotsCreated: slots.length, qrCodesCreated: qrCodes.length };
  }, { timeout: 30_000, maxWait: 5_000 });

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
    select: { merchantId: true, deletedAt: true },
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

  // Metadata-only update. Stock is immutable after creation (reducing was dropped;
  // to add capacity, create a new voucher), so totalStock/qrPerSlot/format/source
  // are never touched here — the schema doesn't even accept them.
  const data = { ...parsed.data } as Record<string, unknown>;
  if (data.startDate) data.startDate = new Date(data.startDate as string);
  if (data.expiryDate) data.expiryDate = new Date(data.expiryDate as string);

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

// DELETE /api/admin/vouchers/:id — Soft delete (manager & admin only).
// Deletion is always allowed; any uploaded/issued codes for this voucher are
// voided ("hangus"). The UI warns before calling this. Soft-delete (deletedAt)
// keeps redemption FK references intact; rendered R2 files are intentionally
// left in place (a separate cron can sweep them later).
adminVouchers.delete("/:id", requireManagerOrAdmin, async (c) => {
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
