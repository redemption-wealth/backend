-- Add vouchers.coverImageUrl: merchant-uploaded cover photo shown full-bleed as
-- the voucher hero (falls back to the merchant logo, then a monogram tile).
-- Nullable, no backfill needed. Idempotent.
-- Apply to production before deploying code that reads/writes it.
ALTER TABLE public.vouchers ADD COLUMN IF NOT EXISTS "coverImageUrl" text;
