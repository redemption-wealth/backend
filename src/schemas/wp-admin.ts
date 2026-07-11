import { z } from "zod";

const urlOrEmpty = z.string().url("URL tidak valid").optional().or(z.literal(""));

export const createQuestSchema = z.object({
  key: z
    .string()
    .min(2)
    .max(64)
    .regex(/^[a-z0-9-]+$/, "Key hanya huruf kecil, angka, dan strip"),
  title: z.string().min(2).max(200),
  description: z.string().max(1000).optional(),
  category: z.enum(["DAILY", "SOCIAL", "REDEEM", "INVITE"]),
  rewardWp: z.coerce.number().int().min(0),
  cadence: z.enum(["ONCE", "DAILY"]),
  targetCount: z.coerce.number().int().min(1).default(1),
  actionUrl: urlOrEmpty,
  sortOrder: z.coerce.number().int().default(0),
});

export const updateQuestSchema = createQuestSchema
  .partial()
  .extend({ isActive: z.boolean().optional() });

export const createRewardSchema = z.object({
  title: z.string().min(2).max(200),
  category: z.enum(["VOUCHER", "MERCH", "SEMBAKO"]),
  partnerName: z.string().max(200).optional(),
  wpCost: z.coerce.number().int().min(1),
  stock: z.coerce.number().int().min(0).nullable().optional(),
  imageUrl: urlOrEmpty,
});

export const updateRewardSchema = createRewardSchema
  .partial()
  .extend({ isActive: z.boolean().optional() });

// Manual WP grant/clawback. Non-zero; sign is the direction.
export const wpAdjustSchema = z.object({
  amount: z.coerce.number().int().refine((n) => n !== 0, "Amount tidak boleh 0"),
  note: z.string().max(300).optional(),
});

export const redemptionStatusSchema = z.object({
  status: z.enum(["FULFILLED", "REJECTED"]),
  // Internal admin note (used on REJECTED for the reason; not shown to the user).
  note: z.string().max(300).optional(),
  // User-visible fulfillment note (voucher code / shipping note) on FULFILLED.
  fulfillmentNote: z.string().max(500).optional(),
});

// WP settings cockpit (Wave 1 exposes only the monthly issuance cap). Kept as an
// object so forward-compatible conversion settings can be added later.
export const wpSettingsSchema = z.object({
  wpMonthlyCapWp: z.coerce
    .number()
    .int()
    .positive("Cap WP bulanan harus lebih dari 0"),
});
