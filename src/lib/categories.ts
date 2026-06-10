// Canonical merchant category taxonomy. The stored value IS the display label
// (e.g. "F&B") — no slug/label mapping is needed anywhere. This is the single
// source of truth: Zod validation (schemas/merchant.ts) and the
// GET /api/admin/categories endpoint both derive from it.
//
// To add/rename a category, edit this list (no DB migration needed — the column
// is a plain text field). Removing a category that existing merchants still use
// will fail validation on their next edit; remap those rows first.
export const MERCHANT_CATEGORIES = [
  "F&B",
  "Sport & Fitness",
  "Music Event",
  "Crypto & Web3 Event",
  "Lifestyle",
  "Fashion & Apparel",
  "Books & Education",
  "Electronics & Gadgets",
  "Beauty & Cosmetics",
  "Health & Supplement",
  "Gaming",
  "Jewellery & Accessories",
  "Travel & Staycation",
  "Entertainment & Cinema",
  "NFT & Digital Collectibles",
  "Transportation & Mobility",
  "Home & Living",
  "Pets",
] as const;
