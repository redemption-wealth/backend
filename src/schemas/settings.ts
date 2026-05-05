import { z } from "zod";

export const updateSettingsSchema = z.object({
  appFeeRate: z.number().min(0).max(50).optional(),
  gasFeeAmount: z.number().min(0).optional(),
});
