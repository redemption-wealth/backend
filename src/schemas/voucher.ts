import { z } from "zod";
import { paginationSchema } from "./common.js";

export const createVoucherSchema = z
  .object({
    merchantId: z.string().uuid(),
    title: z.string().min(2).max(200),
    description: z.string().max(2000).optional(),
    startDate: z.string().or(z.date()),
    expiryDate: z.string().or(z.date()),
    totalStock: z.number().int().positive(),
    basePrice: z.number().min(1000),
    qrPerSlot: z.number().int().min(1).max(2).default(1),
  })
  .refine(
    (data) => new Date(data.expiryDate) >= new Date(data.startDate),
    { message: "expiryDate must be after startDate", path: ["expiryDate"] }
  );

export const updateVoucherSchema = z.object({
  title: z.string().min(2).max(200).optional(),
  description: z.string().max(2000).optional().nullable(),
  startDate: z.string().or(z.date()).optional(),
  expiryDate: z.string().or(z.date()).optional(),
  totalStock: z.number().int().positive().optional(),
  isActive: z.boolean().optional(),
  // Note: basePrice, appFeeRate, gasFeeAmount, totalPrice, qrPerSlot are read-only after creation
});

export const redeemVoucherSchema = z.object({
  idempotencyKey: z.string().uuid(),
  wealthPriceIdr: z.number().positive(),
});

export const voucherQuerySchema = paginationSchema.extend({
  merchantId: z.string().uuid().optional(),
  category: z.string().optional(),
  search: z.string().max(100).optional(),
});
