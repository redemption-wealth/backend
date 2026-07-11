-- WP Profile + Dev-bypass Wave 3 — manual production migration.
--
-- Project convention: backend DB migrations are applied MANUALLY (the Vercel
-- build does NOT run `prisma migrate deploy`). Apply this to the production
-- Supabase database BEFORE deploying the Wave 3 backend code. Prisma columns are
-- camelCase / unmapped, so they are double-quoted here.
--
-- Wave 3 schema delta:
--   app_users — editable user-profile fields exposed via GET/PATCH /api/users/me:
--     "name"        text  — display name (1..80 chars, enforced in app).
--     "username"    text  — unique handle (3..30, alnum/underscore, enforced in app).
--     "phone"       text  — loose phone string.
--     "avatarUrl"   text  — avatar image URL.
--   Plus a UNIQUE index on "username" (partial-friendly: NULLs are allowed and
--   never collide in Postgres, so multiple users without a username are fine).
--
-- NOTE: The dev-only auth bypass (Feature 2 of this wave) is a pure application
-- concern in src/middleware/auth.ts, gated on NODE_ENV !== 'production' AND
-- DEV_AUTH_BYPASS === 'true'. It touches NO schema and can never activate in
-- production; it is mentioned here only so this file documents the full wave.
--
-- Idempotent: safe to run more than once.

ALTER TABLE public.app_users
  ADD COLUMN IF NOT EXISTS "name"      text,
  ADD COLUMN IF NOT EXISTS "username"  text,
  ADD COLUMN IF NOT EXISTS "phone"     text,
  ADD COLUMN IF NOT EXISTS "avatarUrl" text;

-- Unique handle. IF NOT EXISTS keeps this idempotent; matches Prisma's
-- @unique index name (app_users_username_key) so `prisma db pull`/drift checks
-- see them as the same object.
CREATE UNIQUE INDEX IF NOT EXISTS "app_users_username_key"
  ON public.app_users ("username");
