import { z } from "zod";
import { paginationSchema } from "./common.js";

export const createMerchantSchema = z.object({
  name: z.string().min(2).max(200),
  description: z.string().max(2000).optional(),
  categoryId: z.string().uuid("Invalid category ID"),
  logoUrl: z.string().url().optional(),
});

export const updateMerchantSchema = z.object({
  name: z.string().min(2).max(200).optional(),
  description: z.string().max(2000).optional().nullable(),
  categoryId: z.string().uuid("Invalid category ID").optional(),
  logoUrl: z.string().url().optional().nullable(),
  isActive: z.boolean().optional(),
});

export const merchantQuerySchema = paginationSchema.extend({
  categoryId: z.string().uuid().optional(),
  search: z.string().max(100).optional(),
});
