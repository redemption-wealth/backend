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

// Manual fraud-review label. Operational only — never blocks earn/spend.
export const fraudReviewSchema = z.object({
  status: z.enum(["NONE", "REVIEWING", "CLEARED", "FLAGGED"]),
});

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

// WP settings cockpit. Wave 1 exposed the monthly issuance cap; Wave 2 adds the
// WP→$WEALTH conversion knobs. All fields optional — a PATCH updates only what
// it sends, so `wpMonthlyCapWp` keeps working exactly as before.
export const wpSettingsSchema = z
  .object({
    wpMonthlyCapWp: z.coerce
      .number()
      .int()
      .positive("Cap WP bulanan harus lebih dari 0")
      .optional(),
    wpConversionEnabled: z.boolean().optional(),
    wpConversionRate: z.coerce
      .number()
      .int()
      .positive("Rate konversi harus lebih dari 0")
      .optional(),
    wpConvertMinWp: z.coerce
      .number()
      .int()
      .positive("Minimal konversi harus lebih dari 0")
      .optional(),
    wpConvertMaxWpPerMonth: z.coerce
      .number()
      .int()
      .positive("Kuota bulanan harus lebih dari 0")
      .optional(),
    wpConversionMonthlyBudgetWealth: z.coerce
      .number()
      .nonnegative("Anggaran tidak boleh negatif")
      .optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "Tidak ada perubahan",
  });

// Admin: fulfill or reject a WP→$WEALTH conversion. The admin already sent the
// $WEALTH manually (FULFILLED) — this records the outcome. REJECTED refunds WP.
export const conversionStatusSchema = z.object({
  status: z.enum(["FULFILLED", "REJECTED"]),
  // Optional on-chain tx hash the admin recorded after sending $WEALTH manually.
  txHash: z.string().trim().max(120).optional(),
  note: z.string().max(300).optional(),
});
