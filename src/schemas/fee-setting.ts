import { z } from "zod";

export const createFeeSettingSchema = z.object({
  label: z.string().min(2).max(100),
  amountIdr: z.number().int().min(0),
});

export const updateFeeSettingSchema = z.object({
  label: z.string().min(2).max(100).optional(),
  amountIdr: z.number().int().min(0).optional(),
});
