-- Backfill app_users.walletAddress from redemption history.
--
-- Why: the app's /api/auth/user-sync endpoint never existed (silent 404) and
-- the quests sync wiped stored wallets when called without one, so most
-- app_users rows have walletAddress = NULL. That blinds the treasury-inflow
-- matcher (transferMatch) — it cannot pair an on-chain payment with a user
-- (2026-07-17 0x5c18 lost-redemption case).
--
-- A redemption's walletAddress is ground truth (captured at initiate / attached
-- at confirm), so copy each user's most recent known wallet. Idempotent: only
-- fills NULLs, never overwrites an existing address.
--
-- Ships with: sync-preserve fix in services/appUser.ts, the new
-- /api/auth/user-sync route, and the app sending walletAddress on sync.

UPDATE app_users u
SET "walletAddress" = r.wallet, "updatedAt" = now()
FROM (
  SELECT DISTINCT ON ("userEmail") "userEmail", lower("walletAddress") AS wallet
  FROM redemptions
  WHERE "walletAddress" IS NOT NULL
  ORDER BY "userEmail", "createdAt" DESC
) r
WHERE u.email = r."userEmail" AND u."walletAddress" IS NULL;

-- Verify: remaining NULL wallets are users who never redeemed (no row to copy).
-- SELECT count(*) FROM app_users WHERE "walletAddress" IS NULL;
