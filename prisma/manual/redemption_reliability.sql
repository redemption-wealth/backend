-- ============================================================
-- Redemption Reliability — schema for the layered anti-loss fix
-- (see docs/redemption-reliability-plan.md, decisions locked 2026-07-16)
--
-- Idempotent: safe to re-run. Apply to PROD via Supabase SQL Editor
-- BEFORE deploying the dependent backend code.
-- ============================================================

-- 1. Payer wallet on redemptions — lets webhook/sweep match an on-chain
--    transfer back to a PENDING row even when the app never submitted txHash.
ALTER TABLE redemptions ADD COLUMN IF NOT EXISTS "walletAddress" text;

-- 2. Refund bookkeeping (semi-manual refunds, full-total policy).
ALTER TABLE redemptions ADD COLUMN IF NOT EXISTS "refundTxHash" text;
ALTER TABLE redemptions ADD COLUMN IF NOT EXISTS "refundedAt" timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS "redemptions_refundTxHash_key"
  ON redemptions ("refundTxHash");

-- 3. slotId becomes NULLABLE: failed/expired attempts are now KEPT as history
--    (never deleted) and detached from their slot on release, so the unique
--    constraint can no longer lock a slot forever.
ALTER TABLE redemptions ALTER COLUMN "slotId" DROP NOT NULL;

-- 4. New RedemptionStatus value. (ADD VALUE cannot run inside a transaction
--    block in older PG; Supabase SQL Editor runs statements individually, OK.)
ALTER TYPE "RedemptionStatus" ADD VALUE IF NOT EXISTS 'REFUNDED';

-- 5. Status enum for the admin review queue.
DO $$ BEGIN
  CREATE TYPE "UnmatchedTransferStatus" AS ENUM ('OPEN','MATCHED','REFUNDED','IGNORED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 6. Review queue: every treasury inflow that could not be auto-matched to
--    exactly one PENDING redemption. Nothing arriving on-chain may go
--    unrecorded.
CREATE TABLE IF NOT EXISTS unmatched_transfers (
  id                    text PRIMARY KEY,
  "txHash"              text NOT NULL,
  "fromAddress"         text NOT NULL,
  "toAddress"           text NOT NULL,
  "tokenAddress"        text NOT NULL,
  amount                numeric(36,18) NOT NULL,
  "userEmail"           text,
  status                "UnmatchedTransferStatus" NOT NULL DEFAULT 'OPEN',
  "matchedRedemptionId" text,
  "refundTxHash"        text,
  "resolvedBy"          text,
  "resolvedAt"          timestamptz,
  note                  text,
  "createdAt"           timestamptz NOT NULL DEFAULT now(),
  "updatedAt"           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "unmatched_transfers_txHash_key"
  ON unmatched_transfers ("txHash");
CREATE UNIQUE INDEX IF NOT EXISTS "unmatched_transfers_refundTxHash_key"
  ON unmatched_transfers ("refundTxHash");
CREATE INDEX IF NOT EXISTS "unmatched_transfers_status_createdAt_idx"
  ON unmatched_transfers (status, "createdAt");

-- Convention (see wp_referral_usewp_wave5): RLS on, service role bypasses it.
ALTER TABLE unmatched_transfers ENABLE ROW LEVEL SECURITY;

-- 7. Wallet lookup index for the webhook fallback match.
CREATE INDEX IF NOT EXISTS "users_walletAddress_idx"
  ON app_users ("walletAddress");

-- ── Verification (run after) ─────────────────────────────────
-- SELECT column_name FROM information_schema.columns
--  WHERE table_name='redemptions'
--    AND column_name IN ('walletAddress','refundTxHash','refundedAt');
-- SELECT enum_range(NULL::"RedemptionStatus");
-- SELECT count(*) FROM unmatched_transfers;
