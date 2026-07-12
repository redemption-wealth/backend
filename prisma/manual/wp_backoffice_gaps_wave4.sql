-- Back-office WP gaps — Wave 4 manual production migration.
--
-- Project convention: backend DB migrations are applied MANUALLY (the Vercel
-- build does NOT run `prisma migrate deploy`). Apply this to the production
-- Supabase database BEFORE deploying the Wave 4 backend code. Prisma columns are
-- camelCase / unmapped, so they are double-quoted here.
--
-- Wave 4 schema delta:
--   1. WpFraudReviewStatus enum — manual fraud-review label.
--   2. app_users."fraudReviewStatus" — new column, default 'NONE'.
--
-- These power the back-office WP Fraud tab's MANUAL review workflow. The label
-- is operational only: it NEVER blocks a user's earning or spending. There is
-- no auto-freeze (product decision).
--
-- Everything else added in Wave 4 (user-admin enrichment fields, analytics
-- kpi-trends / redemption-sources, global search, notifications feed) is
-- READ-ONLY / DERIVED at query time and needs NO DDL.
--
-- Idempotent: safe to run more than once.

-- 1. WpFraudReviewStatus enum ────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'WpFraudReviewStatus') THEN
    CREATE TYPE public."WpFraudReviewStatus"
      AS ENUM ('NONE', 'REVIEWING', 'CLEARED', 'FLAGGED');
  END IF;
END
$$;

-- 2. app_users.fraudReviewStatus column ──────────────────────────────────────
ALTER TABLE public.app_users
  ADD COLUMN IF NOT EXISTS "fraudReviewStatus"
    public."WpFraudReviewStatus" NOT NULL DEFAULT 'NONE';
