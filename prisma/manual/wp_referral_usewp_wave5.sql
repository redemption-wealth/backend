-- WP Referral flat bonuses + Use WP reward asset pool — Wave 5 manual migration.
--
-- Project convention: backend DB migrations are applied MANUALLY (the Vercel
-- build does NOT run `prisma migrate deploy`). Apply this to the production
-- Supabase database BEFORE deploying the Wave 5 backend code. Prisma columns are
-- camelCase / unmapped, so they are double-quoted here.
--
-- Wave 5 schema delta:
--   1. app_settings   — two referral flat-bonus columns (referrer + referee welcome).
--   2. wp_rewards     — `fulfillmentType` column (AUTO | MANUAL).
--   3. wp_reward_assets — new pool table: one pre-uploaded asset per AUTO redemption.
--
-- NOTE: wp_reward_assets.status/kind and wp_rewards.fulfillmentType are plain
-- TEXT (NOT Postgres enums) — matching wp_redemptions.status — so no ALTER TYPE.
--
-- Idempotent: safe to run more than once.

-- 1. app_settings referral flat-bonus columns ───────────────────────────────
ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS "wpReferrerBonusWp" integer NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS "wpRefereeWelcomeWp" integer NOT NULL DEFAULT 50;

-- 2. wp_rewards fulfillment type ─────────────────────────────────────────────
ALTER TABLE public.wp_rewards
  ADD COLUMN IF NOT EXISTS "fulfillmentType" text NOT NULL DEFAULT 'MANUAL';

-- 3. wp_reward_assets pool table ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.wp_reward_assets (
  "id"           text NOT NULL,
  "rewardId"     text NOT NULL,
  "kind"         text NOT NULL DEFAULT 'CODE',
  "value"        text NOT NULL,
  "status"       text NOT NULL DEFAULT 'AVAILABLE',
  "redemptionId" text,
  "assignedAt"   timestamp(3) without time zone,
  "createdAt"    timestamp(3) without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT wp_reward_assets_pkey PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'wp_reward_assets_rewardId_fkey'
  ) THEN
    ALTER TABLE public.wp_reward_assets
      ADD CONSTRAINT "wp_reward_assets_rewardId_fkey"
      FOREIGN KEY ("rewardId") REFERENCES public.wp_rewards("id")
      ON UPDATE CASCADE ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'wp_reward_assets_redemptionId_fkey'
  ) THEN
    ALTER TABLE public.wp_reward_assets
      ADD CONSTRAINT "wp_reward_assets_redemptionId_fkey"
      FOREIGN KEY ("redemptionId") REFERENCES public.wp_redemptions("id")
      ON UPDATE CASCADE ON DELETE SET NULL;
  END IF;
END
$$;

-- One asset can back at most one redemption.
CREATE UNIQUE INDEX IF NOT EXISTS "wp_reward_assets_redemptionId_key"
  ON public.wp_reward_assets ("redemptionId");
-- Fast "pull one AVAILABLE asset for this reward".
CREATE INDEX IF NOT EXISTS "wp_reward_assets_rewardId_status_idx"
  ON public.wp_reward_assets ("rewardId", "status");
