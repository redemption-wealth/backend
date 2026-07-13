-- Fix: merchants.category enum -> text
--
-- The column `merchants.category` was a legacy Postgres ENUM `MerchantCategory`
-- (values: kuliner, hiburan, event, kesehatan, lifestyle, lainnya), but the app
-- moved to FREE-FORM label categories (see src/lib/categories.ts: "F&B",
-- "Sport & Fitness", "Lifestyle", "Gaming", ...). Inserting a label that isn't in
-- the old enum makes Postgres reject the row -> the create/edit merchant endpoint
-- returns HTTP 500. `prisma/schema.prisma` already declares category as `String`,
-- so the DB is the drift. This converts the column to text to match the code.
--
-- Existing rows keep their current values (kuliner/event/...) as plain text.
-- Idempotent: safe to re-run (does nothing if category is already text).
--
-- Apply to the production Supabase DB (migrations are manual — Vercel does not run
-- `prisma migrate deploy`). Already applied to the current Supabase DB 2026-07-12.

DO $$
BEGIN
  IF (
    SELECT data_type FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'merchants'
      AND column_name = 'category'
  ) = 'USER-DEFINED' THEN
    ALTER TABLE public.merchants ALTER COLUMN category DROP DEFAULT;
    ALTER TABLE public.merchants ALTER COLUMN category TYPE text USING category::text;
  END IF;
END
$$;

-- The `MerchantCategory` enum type is now unused. Left in place (harmless).
-- To remove it later once nothing references it:
--   DROP TYPE IF EXISTS "MerchantCategory";
