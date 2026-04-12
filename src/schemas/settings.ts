import { z } from "zod";

export const updateSettingsSchema = z.object({
  appFeePercentage: z.number().min(0).max(100).optional(),
  tokenContractAddress: z.string().optional().nullable(),
  treasuryWalletAddress: z.string().optional().nullable(),
});
