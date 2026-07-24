-- ============================================================
-- APPLY PENDING WP + COVER MIGRATIONS TO PROD  (2026-07-14)
-- Order: #1 wp_quests -> #2 wave1 -> #3 wave2 -> #4 wave3 -> #5 wave4 -> #7 cover
-- (#6 merchants.category already TEXT on prod -> skipped)
-- Safe to paste whole into Supabase SQL Editor. Wrapped in one transaction.
-- ============================================================
BEGIN;

-- ===== #1 wp_quests.sql (core WP tables) =====

CREATE TABLE public.app_users (
    id text NOT NULL,
    "privyId" text NOT NULL,
    email text NOT NULL,
    "walletAddress" text,
    "referralCode" text NOT NULL,
    "referredById" text,
    "hasDeposited" boolean DEFAULT false NOT NULL,
    "qualifiedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.checkin_streaks (
    "appUserId" text NOT NULL,
    "currentStreak" integer DEFAULT 0 NOT NULL,
    "lastCheckinDate" date,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.quest_completions (
    id text NOT NULL,
    "appUserId" text NOT NULL,
    "questId" text NOT NULL,
    "periodKey" text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.quests (
    id text NOT NULL,
    key text NOT NULL,
    title text NOT NULL,
    description text,
    category text NOT NULL,
    "rewardWp" integer NOT NULL,
    cadence text NOT NULL,
    "targetCount" integer DEFAULT 1 NOT NULL,
    "actionUrl" text,
    "isActive" boolean DEFAULT true NOT NULL,
    "sortOrder" integer DEFAULT 0 NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.wp_ledger (
    id text NOT NULL,
    "appUserId" text NOT NULL,
    amount integer NOT NULL,
    type text NOT NULL,
    "refType" text,
    "refId" text,
    note text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.wp_redemptions (
    id text NOT NULL,
    "appUserId" text NOT NULL,
    "rewardId" text NOT NULL,
    "wpSpent" integer NOT NULL,
    status text DEFAULT 'PENDING'::text NOT NULL,
    note text,
    "fulfilledBy" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.wp_rewards (
    id text NOT NULL,
    title text NOT NULL,
    category text NOT NULL,
    "partnerName" text,
    "wpCost" integer NOT NULL,
    stock integer,
    "isActive" boolean DEFAULT true NOT NULL,
    "imageUrl" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

ALTER TABLE ONLY public.app_users
    ADD CONSTRAINT app_users_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.checkin_streaks
    ADD CONSTRAINT checkin_streaks_pkey PRIMARY KEY ("appUserId");

ALTER TABLE ONLY public.quest_completions
    ADD CONSTRAINT quest_completions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.quests
    ADD CONSTRAINT quests_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.wp_ledger
    ADD CONSTRAINT wp_ledger_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.wp_redemptions
    ADD CONSTRAINT wp_redemptions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.wp_rewards
    ADD CONSTRAINT wp_rewards_pkey PRIMARY KEY (id);

CREATE INDEX app_users_email_idx ON public.app_users USING btree (email);

CREATE UNIQUE INDEX "app_users_privyId_key" ON public.app_users USING btree ("privyId");

CREATE UNIQUE INDEX "app_users_referralCode_key" ON public.app_users USING btree ("referralCode");

CREATE INDEX "app_users_referredById_idx" ON public.app_users USING btree ("referredById");

CREATE UNIQUE INDEX "quest_completions_appUserId_questId_periodKey_key" ON public.quest_completions USING btree ("appUserId", "questId", "periodKey");

CREATE UNIQUE INDEX quests_key_key ON public.quests USING btree (key);

CREATE INDEX "wp_ledger_appUserId_createdAt_idx" ON public.wp_ledger USING btree ("appUserId", "createdAt");

CREATE INDEX "wp_ledger_type_createdAt_idx" ON public.wp_ledger USING btree (type, "createdAt");

CREATE INDEX "wp_redemptions_appUserId_idx" ON public.wp_redemptions USING btree ("appUserId");

CREATE INDEX "wp_redemptions_status_createdAt_idx" ON public.wp_redemptions USING btree (status, "createdAt");

ALTER TABLE ONLY public.app_users
    ADD CONSTRAINT "app_users_referredById_fkey" FOREIGN KEY ("referredById") REFERENCES public.app_users(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.checkin_streaks
    ADD CONSTRAINT "checkin_streaks_appUserId_fkey" FOREIGN KEY ("appUserId") REFERENCES public.app_users(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.quest_completions
    ADD CONSTRAINT "quest_completions_appUserId_fkey" FOREIGN KEY ("appUserId") REFERENCES public.app_users(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.quest_completions
    ADD CONSTRAINT "quest_completions_questId_fkey" FOREIGN KEY ("questId") REFERENCES public.quests(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.wp_ledger
    ADD CONSTRAINT "wp_ledger_appUserId_fkey" FOREIGN KEY ("appUserId") REFERENCES public.app_users(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.wp_redemptions
    ADD CONSTRAINT "wp_redemptions_appUserId_fkey" FOREIGN KEY ("appUserId") REFERENCES public.app_users(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.wp_redemptions
    ADD CONSTRAINT "wp_redemptions_rewardId_fkey" FOREIGN KEY ("rewardId") REFERENCES public.wp_rewards(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE public.app_settings ADD COLUMN IF NOT EXISTS "wpMonthlyCapWp" integer NOT NULL DEFAULT 1000000;

-- ===== #2 wp_lengkap_wave1.sql =====

ALTER TABLE public.wp_redemptions
  ADD COLUMN IF NOT EXISTS "fulfillmentNote" text;
-- ===== #3 wp_conversion_wave2.sql =====

ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS "wpConversionEnabled" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "wpConversionRate" integer NOT NULL DEFAULT 1000,
  ADD COLUMN IF NOT EXISTS "wpConvertMinWp" integer NOT NULL DEFAULT 1000,
  ADD COLUMN IF NOT EXISTS "wpConvertMaxWpPerMonth" integer NOT NULL DEFAULT 100000,
  ADD COLUMN IF NOT EXISTS "wpConversionMonthlyBudgetWealth" numeric(36, 18) NOT NULL DEFAULT 10000;

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
-- ===== #4 wp_profile_devbypass_wave3.sql =====

ALTER TABLE public.app_users
  ADD COLUMN IF NOT EXISTS "name"      text,
  ADD COLUMN IF NOT EXISTS "username"  text,
  ADD COLUMN IF NOT EXISTS "phone"     text,
  ADD COLUMN IF NOT EXISTS "avatarUrl" text;

CREATE UNIQUE INDEX IF NOT EXISTS "app_users_username_key"
  ON public.app_users ("username");
-- ===== #5 wp_backoffice_gaps_wave4.sql =====

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'WpFraudReviewStatus') THEN
    CREATE TYPE public."WpFraudReviewStatus"
      AS ENUM ('NONE', 'REVIEWING', 'CLEARED', 'FLAGGED');
  END IF;
END
$$;

ALTER TABLE public.app_users
  ADD COLUMN IF NOT EXISTS "fraudReviewStatus"
    public."WpFraudReviewStatus" NOT NULL DEFAULT 'NONE';
-- ===== #7 add_voucher_cover_image.sql =====
ALTER TABLE public.vouchers ADD COLUMN IF NOT EXISTS "coverImageUrl" text;


-- ===== Enable RLS pada 8 tabel WP baru (samain pola migrasi enable_rls) =====
-- Backend pakai role postgres (bypass RLS); tanpa policy = API anon/authenticated Supabase ke-block default.
ALTER TABLE public.app_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.checkin_streaks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quest_completions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wp_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wp_redemptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wp_rewards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wp_conversions ENABLE ROW LEVEL SECURITY;

COMMIT;
