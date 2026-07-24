-- ============================================================================
-- One-off DATA recovery (NOT a migration — do NOT re-apply).
-- Applied to REAL prod via Supabase SQL Editor 2026-07-17 ~18:32 WIB.
--
-- Case: user ritanurhaeni@icloud.com paid 6× on-chain but only 5 redemptions
-- were recorded. Missing tx (verified on-chain via two independent RPCs):
--   0x5c18b2681f7e72314e529a18f7b7bd5756a73e25f77a471b8619bf7d71569b17
--   mined 2026-07-17 16:52:59 WIB, 0.164100960789953904 $WEALTH
--   from 0x1eb40c679c4922f1a90d341c3788fc362be29cf6 (Rita's wallet — same
--   sender as her 5 recorded redemptions) to the treasury.
--
-- Root cause: Privy sendTransaction broadcast the tx but threw to the app
-- (timeout/network), so `broadcasted` stayed false → the app called
-- POST /redemptions/:id/cancel → releasePendingRedemption(deleteRow: true)
-- DELETED the pending row. The user retried 36s later (0xf5f8..., recorded).
-- The webhook fallback did NOT queue the orphan into unmatched_transfers
-- (queue was empty for this hash) — follow-up investigation tracked
-- separately; app_users.walletAddress was also NULL for this user, which
-- disables the hybrid matcher's wallet→user lookup entirely.
--
-- Slot claimed: 0d4953c8-8a70-44e9-917d-ab0cf0ae9a75 (slotIndex 14, the last
-- AVAILABLE slot; asset records verified complete, 2/2 = qrPerSlot).
-- Barcode assignment happens via ensureQrAssigned lazy-heal on first open.
-- ============================================================================

BEGIN;

WITH v AS (
  SELECT id, "merchantId", "basePrice", "appFeeSnapshot", "gasFeeSnapshot", "qrPerSlot"
  FROM vouchers WHERE id = '7bf8b227-bb15-4046-8f33-cb1bbf7006d3'
),
slot AS (
  SELECT s.id FROM redemption_slots s
  WHERE s."voucherId" = (SELECT id FROM v) AND s.status = 'AVAILABLE'
    -- Reject a slot whose asset records are incomplete: ensureQrAssigned
    -- silently no-ops on an assetless slot → user would get a voucher
    -- without a barcode.
    AND (SELECT count(*) FROM qr_codes q WHERE q."slotId" = s.id)
        = (SELECT "qrPerSlot" FROM v)
  ORDER BY s."slotIndex" LIMIT 1
  FOR UPDATE
),
claim AS (
  UPDATE redemption_slots SET status = 'REDEEMED', "updatedAt" = now()
  WHERE id = (SELECT id FROM slot)
  RETURNING id
),
math AS (
  SELECT v.*,
    (v."basePrice" + v."basePrice" * v."appFeeSnapshot" / 100 + v."gasFeeSnapshot") AS total_idr,
    0.164100960789953904::numeric AS wealth_amount
  FROM v
)
INSERT INTO redemptions (
  id, "userEmail", "voucherId", "merchantId", "slotId",
  "wealthAmount", "priceIdrAtRedeem", "wealthPriceIdrAtRedeem",
  "appFeeAmount", "gasFeeAmount", "walletAddress",
  "txHash", "idempotencyKey", status, "confirmedAt", "createdAt", "updatedAt"
)
SELECT
  'recovery-5c18b268-pgrvip',
  'ritanurhaeni@icloud.com',
  m.id, m."merchantId", c.id,
  m.wealth_amount,
  round(m."basePrice")::int,
  round(m.total_idr / m.wealth_amount, 4),
  (m."basePrice" * m."appFeeSnapshot" / 100) / (m.total_idr / m.wealth_amount),
  m."gasFeeSnapshot" / (m.total_idr / m.wealth_amount),
  '0x1eb40c679c4922f1a90d341c3788fc362be29cf6',
  '0x5c18b2681f7e72314e529a18f7b7bd5756a73e25f77a471b8619bf7d71569b17',
  'manual-recovery-0x5c18b2681f7e72314e529a18f7b7bd5756a73e25f77a471b8619bf7d71569b17',
  'CONFIRMED',
  now(),
  -- NOTE: columns are `timestamp` WITHOUT time zone (Prisma default) and the
  -- app reads them as UTC. A '+07' literal gets its offset silently DROPPED →
  -- displays 7h in the future. Always write the UTC wall time here.
  -- (Original apply used '2026-07-17 16:52:59+07' by mistake → displayed
  -- 23:52 WIB; corrected post-apply with `SET "createdAt" = now()` — the row
  -- intentionally shows the recovery time, not the on-chain time.)
  now(),
  now()
FROM math m, claim c;

UPDATE vouchers SET
  "remainingStock" = (SELECT count(*) FROM redemption_slots
                      WHERE "voucherId" = '7bf8b227-bb15-4046-8f33-cb1bbf7006d3'
                        AND status = 'AVAILABLE'),
  "updatedAt" = now()
WHERE id = '7bf8b227-bb15-4046-8f33-cb1bbf7006d3';

COMMIT;

-- Verified after apply:
--   SELECT ... FROM redemptions WHERE id = 'recovery-5c18b268-pgrvip';
--   → 1 row, CONFIRMED, slotId 0d4953c8-..., wealthAmount 0.164100960789953904
--   SELECT "remainingStock" FROM vouchers WHERE id = '7bf8b227-...';
--   → 0 (last slot consumed)
