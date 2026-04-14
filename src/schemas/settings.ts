import { z } from "zod";

const walletAddressRegex = /^0x[a-fA-F0-9]{40}$/;

export const updateSettingsSchema = z.object({
  appFeeRate: z.number().min(0).max(50).optional(),
  wealthContractAddress: z.string().optional().nullable(),
  devWalletAddress: z
    .string()
    .regex(walletAddressRegex, "Invalid wallet address format")
    .optional()
    .nullable(),
  alchemyRpcUrl: z.string().optional().nullable(),
  coingeckoApiKey: z.string().optional().nullable(),
});
