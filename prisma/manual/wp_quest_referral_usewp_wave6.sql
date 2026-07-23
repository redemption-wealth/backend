-- ─────────────────────────────────────────────────────────────────────────────
-- Wave 6 — Quest tiered · Referral % · Use WP (3 model)
--
-- Backend DB migrations are applied MANUALLY (the Vercel build does NOT run
-- `prisma migrate deploy`). Apply this to the production Supabase database BEFORE
-- deploying the Wave 6 backend code. Prisma columns are camelCase / unmapped, so
-- they are double-quoted here. Idempotent & additive — safe to re-run; never
-- drops or rewrites existing data.
--
-- Built incrementally per phase:
--   Phase 1 (Referral %)  → app_users.referralRateBps                [below]
--   Phase 2 (Use WP)      → wp_redemptions/wp_rewards columns         [added in Phase 2]
--   Phase 3 (Quest tiers) → quests.milestoneBaseWp/milestoneLadder    [added in Phase 3]
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Phase 1: Referral percentage ────────────────────────────────────────────
-- Per-user referral commission rate in basis points (1000 = 10%). Manager sets
-- KOLs higher (e.g. 4000 = 40%) from the back-office. Default 10% for everyone.
ALTER TABLE public.app_users
  ADD COLUMN IF NOT EXISTS "referralRateBps" integer NOT NULL DEFAULT 1000;

-- Backs the referral idempotency lookup (referrer, refType, source refId).
CREATE INDEX IF NOT EXISTS "wp_ledger_appUserId_refType_refId_idx"
  ON public.wp_ledger ("appUserId", "refType", "refId");

-- ── Phase 2: Use WP (physical goods + crypto campaign + expiry) ──────────────
-- Physical-goods shipping capture + crypto payout capture on redemptions.
ALTER TABLE public.wp_redemptions
  ADD COLUMN IF NOT EXISTS "recipientName" text,
  ADD COLUMN IF NOT EXISTS "recipientPhone" text,
  ADD COLUMN IF NOT EXISTS "shippingAddress" text,
  ADD COLUMN IF NOT EXISTS "walletAddress" text,
  ADD COLUMN IF NOT EXISTS "payoutTxHash" text;

-- Crypto campaign display fields + voucher-style expiry on rewards. `category`
-- gains a new allowed TEXT value 'CRYPTO' (no enum → no ALTER TYPE).
ALTER TABLE public.wp_rewards
  ADD COLUMN IF NOT EXISTS "cryptoAsset" text,
  ADD COLUMN IF NOT EXISTS "cryptoAmount" text,
  ADD COLUMN IF NOT EXISTS "expiresAt" timestamptz;

-- ── Phase 3: Quest tiers ─────────────────────────────────────────────────────
-- Tiered/repeatable milestone quests: reward at tier N = N × milestoneBaseWp,
-- unlocked at each count in milestoneLadder (CSV). Null → legacy single-shot.
ALTER TABLE public.quests
  ADD COLUMN IF NOT EXISTS "milestoneBaseWp" integer,
  ADD COLUMN IF NOT EXISTS "milestoneLadder" text;
