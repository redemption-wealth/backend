import { z } from "zod";
import { paginationSchema } from "./common.js";

export const createVoucherSchema = z
  .object({
    merchantId: z.string().uuid(),
    title: z.string().min(2).max(200),
    description: z.string().max(2000).optional(),
    startDate: z.string().or(z.date()),
    endDate: z.string().or(z.date()),
    totalStock: z.number().int().positive(),
    priceIdr: z.number().int().min(1000),
    qrPerRedemption: z.number().int().min(1).max(2).default(1),
  })
  .refine(
    (data) => new Date(data.endDate) >= new Date(data.startDate),
    { message: "endDate must be after startDate", path: ["endDate"] }
  );

export const updateVoucherSchema = z.object({
  title: z.string().min(2).max(200).optional(),
  description: z.string().max(2000).optional().nullable(),
  startDate: z.string().or(z.date()).optional(),
  endDate: z.string().or(z.date()).optional(),
  totalStock: z.number().int().positive().optional(),
  priceIdr: z.number().int().min(1000).optional(),
  isActive: z.boolean().optional(),
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
