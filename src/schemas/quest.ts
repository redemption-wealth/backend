import { z } from "zod";

// Body for POST /api/quests/sync — both fields optional. The referral code is
// only honoured on the referee's very first sync (set-once in the service).
export const syncSchema = z.object({
  referralCode: z
    .string()
    .trim()
    .min(4, "Kode referral tidak valid")
    .max(16, "Kode referral tidak valid")
    .optional(),
  walletAddress: z.string().trim().max(100).optional(),
});

export type SyncInput = z.infer<typeof syncSchema>;
