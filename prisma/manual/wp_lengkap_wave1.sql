-- WP "lengkap" Wave 1 — manual production migration.
--
-- Project convention: backend DB migrations are applied MANUALLY (the Vercel
-- build does NOT run `prisma migrate deploy`). Apply this to the production
-- Supabase database BEFORE deploying the Wave 1 backend code. Prisma columns are
-- camelCase / unmapped, so they are double-quoted here.
--
-- Wave 1 schema delta:
--   1. wp_redemptions."fulfillmentNote" — user-visible fulfillment note (voucher
--      code / shipping note) shown to the end user via GET /api/wp/redemptions.
--
-- Idempotent: safe to run more than once.
--
-- NOTE: The WP monthly cap column (app_settings."wpMonthlyCapWp") and the
-- milestone quest columns (quests."targetCount", "category") already exist from
-- the earlier WP MVP schema (see prisma/manual/wp_quests.sql). Wave 1 adds no new
-- columns beyond "fulfillmentNote"; the milestone engine, overview and settings
-- endpoints are pure application logic over the existing schema.

ALTER TABLE public.wp_redemptions
  ADD COLUMN IF NOT EXISTS "fulfillmentNote" text;
