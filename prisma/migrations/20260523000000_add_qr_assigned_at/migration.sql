-- Separate the "assigned" (status → REDEEMED, QR handed to user) timestamp from
-- the "used" (status → USED, scanned by merchant) timestamp. Previously both
-- were written to usedAt, so the QR monitor's Assigned column was empty and the
-- Used column showed assignment times.
ALTER TABLE "qr_codes" ADD COLUMN "assignedAt" TIMESTAMP(3);

-- Backfill existing REDEEMED QR codes: their redeem time was stored in usedAt
-- (old overload). Move it to assignedAt and clear usedAt — these QRs were
-- assigned, not scanned. The status = 'REDEEMED' guard leaves genuinely USED
-- rows (which legitimately own usedAt) untouched.
UPDATE "qr_codes"
SET "assignedAt" = "usedAt", "usedAt" = NULL
WHERE "status" = 'REDEEMED' AND "usedAt" IS NOT NULL;
