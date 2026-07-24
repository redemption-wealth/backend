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
  // Tiered milestones (INVITE/REDEEM): reward at tier N = N × milestoneBaseWp,
  // unlocked at each count in milestoneLadder (CSV). Both null → single-shot.
  milestoneBaseWp: z.coerce.number().int().min(1).nullable().optional(),
  milestoneLadder: z
    .string()
    .trim()
    .max(200)
    .nullable()
    .optional()
    .transform((v) => (v ? v : null)),
});

export const updateQuestSchema = createQuestSchema
  .partial()
  .extend({ isActive: z.boolean().optional() });

const rewardBase = z.object({
  title: z.string().min(2).max(200),
  category: z.enum(["VOUCHER", "MERCH", "SEMBAKO", "CRYPTO"]),
  partnerName: z.string().max(200).optional(),
  wpCost: z.coerce.number().int().min(1),
  stock: z.coerce.number().int().min(0).nullable().optional(),
  imageUrl: urlOrEmpty,
  // AUTO = fulfilled instantly from the asset pool; MANUAL = admin ships/fulfils.
  fulfillmentType: z.enum(["AUTO", "MANUAL"]).default("MANUAL"),
  // CRYPTO campaign fields. Optional at the object level; REQUIRED when
  // category === "CRYPTO" (enforced by requireCryptoFields below).
  cryptoAsset: z.string().trim().min(1).max(50).optional(),
  cryptoAmount: z.string().trim().min(1).max(100).optional(),
  // Accept an ISO date string and coerce to Date. Nullable so an update can
  // clear it on a non-crypto reward.
  expiresAt: z.coerce.date().nullable().optional(),
});

// When a payload sets category to CRYPTO it must carry the three campaign
// fields. On updates that don't touch category this is a no-op (category
// undefined), so editing an existing CRYPTO reward's title alone still works.
function requireCryptoFields(
  v: {
    category?: string;
    cryptoAsset?: string;
    cryptoAmount?: string;
    expiresAt?: Date | null;
    fulfillmentType?: string;
  },
  ctx: z.RefinementCtx,
) {
  // AUTO instant-fulfilment (from a code pool) only makes sense for digital
  // vouchers. Physical goods + crypto must be MANUAL so an admin actually
  // ships/sends them — never auto-marked FULFILLED with no delivery.
  if (v.category && v.category !== "VOUCHER" && v.fulfillmentType === "AUTO") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["fulfillmentType"],
      message: "Hanya voucher yang boleh AUTO; barang & crypto harus MANUAL",
    });
  }
  if (v.category !== "CRYPTO") return;
  if (!v.cryptoAsset)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["cryptoAsset"], message: "Wajib untuk reward CRYPTO" });
  if (!v.cryptoAmount)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["cryptoAmount"], message: "Wajib untuk reward CRYPTO" });
  if (!v.expiresAt)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["expiresAt"], message: "Wajib untuk reward CRYPTO" });
}

export const createRewardSchema = rewardBase.superRefine(requireCryptoFields);

export const updateRewardSchema = rewardBase
  .partial()
  .extend({ isActive: z.boolean().optional() })
  .superRefine(requireCryptoFields);

// Bulk-add pool assets to an AUTO reward. `values` is the pasted list of codes /
// links / image URLs / QR payloads (one per line on the client).
export const rewardAssetsSchema = z.object({
  kind: z.enum(["CODE", "LINK", "IMAGE", "QR"]).default("CODE"),
  values: z
    .array(z.string().trim().min(1).max(2000))
    .min(1, "Minimal 1 aset")
    .max(1000, "Maksimal 1000 aset per unggahan"),
});

// Manual fraud-review label. Operational only — never blocks earn/spend.
export const fraudReviewSchema = z.object({
  status: z.enum(["NONE", "REVIEWING", "CLEARED", "FLAGGED"]),
});

// Referral commission rate in basis points (0..10000 = 0%..100%). 1000 = 10%.
export const referralRateSchema = z.object({
  referralRateBps: z.coerce.number().int().min(0).max(10000),
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
  // CRYPTO campaign: the on-chain payout tx hash the admin records on FULFILLED
  // after sending the crypto manually. Recorded on the redemption, not sent.
  payoutTxHash: z.string().trim().max(120).optional(),
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
    // Referral flat bonuses (0 disables that leg).
    wpReferrerBonusWp: z.coerce
      .number()
      .int()
      .nonnegative("Bonus referrer tidak boleh negatif")
      .optional(),
    wpRefereeWelcomeWp: z.coerce
      .number()
      .int()
      .nonnegative("Welcome bonus tidak boleh negatif")
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
