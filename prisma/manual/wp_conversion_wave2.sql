-- WP → $WEALTH conversion — Wave 2 manual production migration.
--
-- Project convention: backend DB migrations are applied MANUALLY (the Vercel
-- build does NOT run `prisma migrate deploy`). Apply this to the production
-- Supabase database BEFORE deploying the Wave 2 backend code. Prisma columns are
-- camelCase / unmapped, so they are double-quoted here.
--
-- Wave 2 schema delta:
--   1. app_settings — five WP→$WEALTH conversion cockpit columns.
--   2. wp_conversions — new table for conversion requests (manual treasury).
--
-- NOTE on ledger types: wp_ledger."type" is a plain TEXT column (NOT a Postgres
-- enum), so the new CONVERT_SPEND / CONVERT_REFUND ledger types need NO DDL —
-- they are enforced only by the application (src/services/wp.ts). There is
-- therefore no `ALTER TYPE ... ADD VALUE` in this file.
--
-- Idempotent: safe to run more than once.

-- 1. app_settings conversion columns ────────────────────────────────────────
ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS "wpConversionEnabled" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "wpConversionRate" integer NOT NULL DEFAULT 1000,
  ADD COLUMN IF NOT EXISTS "wpConvertMinWp" integer NOT NULL DEFAULT 1000,
  ADD COLUMN IF NOT EXISTS "wpConvertMaxWpPerMonth" integer NOT NULL DEFAULT 100000,
  ADD COLUMN IF NOT EXISTS "wpConversionMonthlyBudgetWealth" numeric(36, 18) NOT NULL DEFAULT 10000;

-- 2. WpConversionStatus enum + wp_conversions table ─────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'WpConversionStatus') THEN
    CREATE TYPE public."WpConversionStatus" AS ENUM ('PENDING', 'FULFILLED', 'REJECTED');
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS public.wp_conversions (
  "id"           text NOT NULL,
  "appUserId"    text NOT NULL,
  "wpBurned"     integer NOT NULL,
  "wealthAmount" numeric(36, 18) NOT NULL,
  "rate"         integer NOT NULL,
  "toAddress"    text NOT NULL,
  "status"       public."WpConversionStatus" NOT NULL DEFAULT 'PENDING',
  "txHash"       text,
  "note"         text,
  "fulfilledBy"  text,
  "createdAt"    timestamp(3) without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    timestamp(3) without time zone NOT NULL,
  CONSTRAINT wp_conversions_pkey PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'wp_conversions_appUserId_fkey'
  ) THEN
    ALTER TABLE public.wp_conversions
      ADD CONSTRAINT "wp_conversions_appUserId_fkey"
      FOREIGN KEY ("appUserId") REFERENCES public.app_users("id")
      ON UPDATE CASCADE ON DELETE RESTRICT;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS "wp_conversions_appUserId_createdAt_idx"
  ON public.wp_conversions ("appUserId", "createdAt");
CREATE INDEX IF NOT EXISTS "wp_conversions_status_createdAt_idx"
  ON public.wp_conversions ("status", "createdAt");
