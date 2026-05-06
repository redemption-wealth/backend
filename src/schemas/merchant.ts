import { z } from "zod";
import { paginationSchema } from "./common.js";

const merchantCategoryEnum = z.enum(["kuliner", "hiburan", "event", "kesehatan", "lifestyle", "lainnya"]);

export const createMerchantSchema = z.object({
  name: z.string().min(2).max(200),
  description: z.string().max(2000).optional(),
  category: merchantCategoryEnum.optional(),
  logoUrl: z.string().url().optional(),
});

export const updateMerchantSchema = z.object({
  name: z.string().min(2).max(200).optional(),
  description: z.string().max(2000).optional().nullable(),
  category: merchantCategoryEnum.optional(),
  logoUrl: z.string().url().optional().nullable(),
  isActive: z.boolean().optional(),
});

export const merchantQuerySchema = paginationSchema.extend({
  category: merchantCategoryEnum.optional(),
  search: z.string().max(100).optional(),
});
