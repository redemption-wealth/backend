-- ============================================================
-- RECOVERY: PGR Tasikmalaya VIP — rakasyaefudin9423@gmail.com
--
-- Case (2026-07-16): on-chain transfer succeeded but the app died before
-- submitting the txHash; the stale sweep then DELETED the PENDING row, so the
-- user paid 0.1509659771120788 $WEALTH and got nothing.
--
-- On-chain facts (Ethereum mainnet, verified via eth_getTransactionReceipt):
--   tx     0x0b5fc663dace323b5e63baf8792d8eb56db03379e036362714066ba407cbad47
--   status success, block 25542302
--   token  0xafa702c0a2a3a0cf1bd09435db61c913ccde8546 ($WEALTH)
--   to     0x1fb56441c55e3730f9f5c43d94a5ff21ecfafe01 (treasury)
--
-- This inserts the redemption directly as CONFIRMED. Barcode assignment is
-- NOT done here — the backend's lazy-heal (ensureQrAssigned on
-- GET /api/redemptions/:id) renders + assigns the tickets automatically the
-- first time the user opens the redemption in the app.
--
-- Run each STEP separately in the Supabase SQL Editor. STEP 1-2 are read-only.
-- ============================================================

-- STEP 1 — verify the voucher (expect 1 row: basePrice 300000, qrPerSlot 2,
--          appFeeSnapshot 0.7, gasFeeSnapshot 500, BARCODE / MERCHANT_UPLOADED)
SELECT id, title, "basePrice", "qrPerSlot", "remainingStock", "totalStock",
       "appFeeSnapshot", "gasFeeSnapshot", format, "assetSource"
FROM vouchers
WHERE id = '7bf8b227-bb15-4046-8f33-cb1bbf7006d3';

-- STEP 2a — verify the tx is not already recorded (expect 0 rows)
SELECT id, status FROM redemptions
WHERE "txHash" = '0x0b5fc663dace323b5e63baf8792d8eb56db03379e036362714066ba407cbad47';

-- STEP 2b — verify a free slot exists with its 2 ticket values pre-stored
--           (expect >=1 row with qr_records = 2, values_ok = true)
SELECT s.id, s."slotIndex", count(q.id) AS qr_records,
       bool_and(q.value IS NOT NULL) AS values_ok
FROM redemption_slots s
JOIN qr_codes q ON q."slotId" = s.id
WHERE s."voucherId" = '7bf8b227-bb15-4046-8f33-cb1bbf7006d3'
  AND s.status = 'AVAILABLE'
GROUP BY s.id, s."slotIndex"
ORDER BY s."slotIndex"
LIMIT 3;

-- STEP 3 — THE RECOVERY (single transaction)
BEGIN;

WITH v AS (
  SELECT id, "merchantId", "basePrice", "appFeeSnapshot", "gasFeeSnapshot"
  FROM vouchers WHERE id = '7bf8b227-bb15-4046-8f33-cb1bbf7006d3'
),
slot AS (
  SELECT s.id FROM redemption_slots s
  WHERE s."voucherId" = (SELECT id FROM v) AND s.status = 'AVAILABLE'
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
    0.1509659771120788::numeric AS wealth_amount
  FROM v
)
INSERT INTO redemptions (
  id, "userEmail", "voucherId", "merchantId", "slotId",
  "wealthAmount", "priceIdrAtRedeem", "wealthPriceIdrAtRedeem",
  "appFeeAmount", "gasFeeAmount",
  "txHash", "idempotencyKey", status, "confirmedAt", "createdAt", "updatedAt"
)
SELECT
  'recovery-0b5fc663-pgrvip',
  'rakasyaefudin9423@gmail.com',
  m.id, m."merchantId", c.id,
  m.wealth_amount,
  round(m."basePrice")::int,
  round(m.total_idr / m.wealth_amount, 4),
  (m."basePrice" * m."appFeeSnapshot" / 100) / (m.total_idr / m.wealth_amount),
  m."gasFeeSnapshot" / (m.total_idr / m.wealth_amount),
  '0x0b5fc663dace323b5e63baf8792d8eb56db03379e036362714066ba407cbad47',
  'manual-recovery-0x0b5fc663dace323b5e63baf8792d8eb56db03379e036362714066ba407cbad47',
  'CONFIRMED',
  now(),
  '2026-07-16 09:41:00+07',  -- original purchase time (Privy dashboard)
  now()
FROM math m, claim c;

UPDATE vouchers SET
  "remainingStock" = (SELECT count(*) FROM redemption_slots
                      WHERE "voucherId" = '7bf8b227-bb15-4046-8f33-cb1bbf7006d3'
                        AND status = 'AVAILABLE'),
  "updatedAt" = now()
WHERE id = '7bf8b227-bb15-4046-8f33-cb1bbf7006d3';

COMMIT;

-- STEP 4 — verify (expect: 1 CONFIRMED row; remainingStock reduced by 1)
SELECT id, "userEmail", status, "wealthAmount", "priceIdrAtRedeem",
       "wealthPriceIdrAtRedeem", "txHash", "createdAt", "confirmedAt"
FROM redemptions WHERE id = 'recovery-0b5fc663-pgrvip';

SELECT "remainingStock", "totalStock"
FROM vouchers WHERE id = '7bf8b227-bb15-4046-8f33-cb1bbf7006d3';
