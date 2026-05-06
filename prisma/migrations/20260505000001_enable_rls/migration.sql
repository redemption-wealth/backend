-- Enable Row Level Security on all public tables
-- Backend (Hono + Prisma) uses DATABASE_URL (postgres superuser) which bypasses RLS.
-- No policies are added — PostgREST (anon/authenticated roles) is blocked by default.

-- Better Auth tables
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "verifications" ENABLE ROW LEVEL SECURITY;

-- App tables
ALTER TABLE "admins" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "password_setup_tokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "merchants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "app_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "vouchers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "redemption_slots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "qr_codes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "redemptions" ENABLE ROW LEVEL SECURITY;

-- Prisma internal table (flagged by Supabase advisor)
ALTER TABLE "_prisma_migrations" ENABLE ROW LEVEL SECURITY;
