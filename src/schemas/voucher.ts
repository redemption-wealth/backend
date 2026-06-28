import { z } from "zod";
import { paginationSchema } from "./common.js";
import {
  VOUCHER_FORMATS,
  ASSET_SOURCES,
  BARCODE_SYMBOLOGY_KEYS,
} from "../services/asset-values.js";

export const createVoucherSchema = z
  .object({
    merchantId: z.string().min(1, "Merchant wajib dipilih"),
    title: z.string().min(2, "Judul minimal 2 karakter").max(200, "Judul maksimal 200 karakter"),
    description: z.string().max(2000, "Deskripsi maksimal 2000 karakter").optional(),
    startDate: z.string().or(z.date()),
    expiryDate: z.string().or(z.date()),
    totalStock: z.coerce.number().int("Stok harus bilangan bulat").positive("Stok minimal 1"),
    basePrice: z.coerce.number().min(1000, "Harga minimal Rp 1.000"),
    qrPerSlot: z.coerce.number().int().min(1).max(2).default(1),
    // Multi-format asset fields
    format: z.enum(VOUCHER_FORMATS).default("QR"),
    assetSource: z.enum(ASSET_SOURCES).default("WEALTH_GENERATED"),
    barcodeSymbology: z.enum(BARCODE_SYMBOLOGY_KEYS).optional(),
    values: z.array(z.string()).optional(), // merchant-uploaded values (per-value rules validated in the route)
  })
  .refine(
    (data) => new Date(data.expiryDate) >= new Date(data.startDate),
    { message: "Tanggal kadaluarsa harus setelah tanggal mulai", path: ["expiryDate"] },
  )
  // Wealth-generated vouchers are QR-only and never carry uploaded values.
  .refine(
    (data) => data.assetSource !== "WEALTH_GENERATED" || data.format === "QR",
    { message: "Voucher yang digenerate Wealth harus format QR", path: ["format"] },
  )
  .refine(
    (data) =>
      data.assetSource !== "WEALTH_GENERATED" ||
      !data.values ||
      data.values.length === 0,
    { message: "Voucher Wealth tidak boleh menyertakan nilai upload", path: ["values"] },
  )
  // Merchant-uploaded vouchers require values; count/dedup/symbology checked in the route.
  .refine(
    (data) =>
      data.assetSource !== "MERCHANT_UPLOADED" ||
      (Array.isArray(data.values) && data.values.length > 0),
    { message: "Voucher upload wajib menyertakan nilai/kode", path: ["values"] },
  )
  // Barcode format needs a symbology to render.
  .refine(
    (data) => data.format !== "BARCODE" || !!data.barcodeSymbology,
    { message: "Format barcode wajib memilih simbologi", path: ["barcodeSymbology"] },
  );

// Multipart (image-upload) create: numeric fields arrive as strings from
// FormData, so coerce them. assetSource/assetInputType are implied
// (MERCHANT_UPLOADED / IMAGE). Image upload is for QR or BARCODE only.
export const createVoucherImageSchema = z
  .object({
    merchantId: z.string().min(1, "Merchant wajib dipilih"),
    title: z.string().min(2, "Judul minimal 2 karakter").max(200, "Judul maksimal 200 karakter"),
    description: z.string().max(2000, "Deskripsi maksimal 2000 karakter").optional(),
    startDate: z.string().or(z.date()),
    expiryDate: z.string().or(z.date()),
    totalStock: z.coerce.number().int("Stok harus bilangan bulat").positive("Stok minimal 1"),
    basePrice: z.coerce.number().min(1000, "Harga minimal Rp 1.000"),
    qrPerSlot: z.coerce.number().int().min(1).max(2).default(1),
    format: z.enum(["QR", "BARCODE"]),
    barcodeSymbology: z.enum(BARCODE_SYMBOLOGY_KEYS).optional(),
  })
  .refine(
    (data) => new Date(data.expiryDate) >= new Date(data.startDate),
    { message: "Tanggal kadaluarsa harus setelah tanggal mulai", path: ["expiryDate"] },
  );

// totalStock / qrPerSlot / format / assetSource are immutable after creation.
// basePrice is read-only; fees are computed from live settings.
export const updateVoucherSchema = z.object({
  title: z.string().min(2).max(200).optional(),
  description: z.string().max(2000).optional().nullable(),
  startDate: z.string().or(z.date()).optional(),
  expiryDate: z.string().or(z.date()).optional(),
  isActive: z.boolean().optional(),
});

export const redeemVoucherSchema = z.object({
  idempotencyKey: z.string().uuid(),
});

export const voucherQuerySchema = paginationSchema.extend({
  merchantId: z.string().min(1).optional(),
  category: z.string().optional(),
  search: z.string().max(100).optional(),
});
