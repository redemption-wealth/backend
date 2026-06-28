import { Hono, type Context } from "hono";
import { Prisma } from "@prisma/client";
import { prisma } from "../../db.js";
import { requireOwner, requireManagerOrAdmin, type AuthEnv } from "../../middleware/auth.js";
import {
  createVoucherSchema,
  createVoucherImageSchema,
  updateVoucherSchema,
} from "../../schemas/voucher.js";
import { validateUploadedValues } from "../../services/asset-values.js";
import {
  extractZipImages,
  validateImageUpload,
  storeVoucherAssetImage,
} from "../../services/asset-images.js";
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

// Shared persistence for both create paths (value/CSV via JSON, image via
// multipart): builds voucher + slots + QR rows atomically. The caller pre-builds
// the qrCodes (value-based carries `value`; image-based carries a real
// `imageUrl`), so there is a single transaction shape — no duplication.
async function persistVoucherWithAssets(params: {
  voucherId: string;
  merchantId: string;
  title: string;
  description?: string | null;
  startDate: string | Date;
  expiryDate: string | Date;
  totalStock: number;
  basePrice: number;
  qrPerSlot: number;
  format: "QR" | "CODE" | "BARCODE";
  assetSource: "WEALTH_GENERATED" | "MERCHANT_UPLOADED";
  assetInputType: "VALUE" | "IMAGE";
  barcodeSymbology?: string | null;
  appFeeRate: Prisma.Decimal;
  gasFeeAmount: Prisma.Decimal;
  slots: Array<{ id: string; slotIndex: number }>;
  qrCodes: Array<{
    id: string;
    slotId: string;
    qrNumber: number;
    token: string;
    value: string | null;
    imageUrl: string;
    imageHash: string;
  }>;
}) {
  const basePriceDecimal = new Prisma.Decimal(params.basePrice.toString());
  return prisma.$transaction(
    async (tx) => {
      const voucher = await tx.voucher.create({
        data: {
          id: params.voucherId,
          merchantId: params.merchantId,
          title: params.title,
          description: params.description ?? undefined,
          startDate: new Date(params.startDate),
          expiryDate: new Date(params.expiryDate),
          totalStock: params.totalStock,
          remainingStock: params.totalStock,
          basePrice: basePriceDecimal,
          qrPerSlot: params.qrPerSlot,
          format: params.format,
          assetSource: params.assetSource,
          assetInputType: params.assetInputType,
          barcodeSymbology:
            params.format === "BARCODE" ? (params.barcodeSymbology ?? null) : null,
          appFeeSnapshot: params.appFeeRate,
          gasFeeSnapshot: params.gasFeeAmount,
        },
      });

      await tx.redemptionSlot.createMany({
        data: params.slots.map((slot) => ({
          id: slot.id,
          voucherId: voucher.id,
          slotIndex: slot.slotIndex,
        })),
      });

      await tx.qrCode.createMany({
        data: params.qrCodes.map((qr) => ({
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

      return {
        voucher,
        slotsCreated: params.slots.length,
        qrCodesCreated: params.qrCodes.length,
      };
    },
    { timeout: 30_000, maxWait: 5_000 },
  );
}

// Create a MERCHANT_UPLOADED + IMAGE voucher from a ZIP of finished image files.
// The images are stored as-is and shown unchanged at redeem (no rendering) — used
// when the exact original barcode/QR must be preserved (e.g. GS1).
async function createVoucherFromImages(c: Context<AuthEnv>) {
  const adminAuth = c.get("adminAuth");
  const form = await c.req.parseBody();

  const parsed = createVoucherImageSchema.safeParse(form);
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
  }

  const file = form["images"];
  if (!file || typeof file === "string" || typeof (file as File).arrayBuffer !== "function") {
    return c.json(
      { error: "File ZIP gambar wajib diupload (field 'images')", code: "IMAGE_FILE_REQUIRED" },
      400,
    );
  }

  const merchantId =
    adminAuth.role === "ADMIN" ? adminAuth.merchantId! : parsed.data.merchantId;
  const { title, description, startDate, expiryDate, totalStock, basePrice, qrPerSlot, format, barcodeSymbology } =
    parsed.data;

  if (totalStock * qrPerSlot > MAX_QR_PER_VOUCHER) {
    return c.json(
      {
        error: `Total aset (stok × per slot) melebihi batas maksimal ${MAX_QR_PER_VOUCHER.toLocaleString("id-ID")}.`,
        code: "STOCK_LIMIT_EXCEEDED",
        max: MAX_QR_PER_VOUCHER,
        requested: totalStock * qrPerSlot,
      },
      422,
    );
  }

  let entries;
  try {
    entries = extractZipImages(Buffer.from(await (file as File).arrayBuffer()));
  } catch {
    return c.json({ error: "File ZIP tidak valid", code: "INVALID_ZIP" }, 400);
  }

  const validation = await validateImageUpload({ entries, totalStock, qrPerSlot });
  if (!validation.ok) {
    return c.json(
      {
        error: "Validasi gambar gagal",
        code: "IMAGE_VALIDATION_FAILED",
        details: validation.errors,
        expected: validation.expected,
        received: validation.received,
      },
      422,
    );
  }

  const { appFeeRate, gasFeeAmount } = await getLiveFeeConfig();
  const voucherId = randomUUID();
  const slots = Array.from({ length: totalStock }, (_, i) => ({
    id: randomUUID(),
    slotIndex: i + 1,
  }));

  // Upload each image to R2 (outside the DB transaction) in file order, mapped
  // slot N / qr M → entries[(N-1) * qrPerSlot + (M-1)].
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
      const idx = (slot.slotIndex - 1) * qrPerSlot + (qrNum - 1);
      const { imageUrl, imageHash } = await storeVoucherAssetImage(
        voucherId,
        slot.slotIndex,
        qrNum,
        entries[idx].data,
      );
      qrCodes.push({
        id: randomUUID(),
        slotId: slot.id,
        qrNumber: qrNum,
        token: randomBytes(16).toString("hex"),
        value: null,
        imageUrl,
        imageHash,
      });
    }
  }

  const result = await persistVoucherWithAssets({
    voucherId,
    merchantId,
    title,
    description,
    startDate,
    expiryDate,
    totalStock,
    basePrice,
    qrPerSlot,
    format,
    assetSource: "MERCHANT_UPLOADED",
    assetInputType: "IMAGE",
    barcodeSymbology,
    appFeeRate,
    gasFeeAmount,
    slots,
    qrCodes,
  });

  return c.json(
    { ...result, voucher: injectFeeFields(result.voucher, appFeeRate, gasFeeAmount) },
    201,
  );
}

// POST /api/admin/vouchers — Create voucher with atomic slot + QR generation.
// JSON body = Wealth-generated or merchant value/CSV; multipart = image upload.
adminVouchers.post("/", async (c) => {
  const adminAuth = c.get("adminAuth");
  const contentType = c.req.header("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    return createVoucherFromImages(c);
  }

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

  const result = await persistVoucherWithAssets({
    voucherId: randomUUID(),
    merchantId,
    title,
    description,
    startDate,
    expiryDate,
    totalStock,
    basePrice,
    qrPerSlot,
    format,
    assetSource,
    assetInputType: "VALUE",
    barcodeSymbology,
    appFeeRate,
    gasFeeAmount,
    slots,
    qrCodes,
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
