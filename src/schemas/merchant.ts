import { z } from "zod";
import { paginationSchema } from "./common.js";

const merchantCategories = [
  "kuliner",
  "hiburan",
  "event",
  "kesehatan",
  "lifestyle",
  "travel",
] as const;

export const createMerchantSchema = z.object({
  name: z.string().min(2).max(200),
  description: z.string().max(2000).optional(),
  category: z.enum(merchantCategories),
  logoUrl: z.string().url().optional(),
});

export const updateMerchantSchema = z.object({
  name: z.string().min(2).max(200).optional(),
  description: z.string().max(2000).optional().nullable(),
  category: z.enum(merchantCategories).optional(),
  logoUrl: z.string().url().optional().nullable(),
  isActive: z.boolean().optional(),
});

export const merchantQuerySchema = paginationSchema.extend({
  category: z.enum(merchantCategories).optional(),
  search: z.string().max(100).optional(),
});
