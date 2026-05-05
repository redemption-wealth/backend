-- Drop token column added in previous iteration (scan uses QR id, not token)
ALTER TABLE "qr_codes" DROP COLUMN IF EXISTS "token";
