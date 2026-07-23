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
