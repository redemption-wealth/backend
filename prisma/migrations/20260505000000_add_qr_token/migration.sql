ALTER TABLE "qr_codes" ADD COLUMN "token" TEXT NOT NULL DEFAULT '';
UPDATE "qr_codes" SET "token" = encode(gen_random_bytes(16), 'hex') WHERE "token" = '';
ALTER TABLE "qr_codes" ALTER COLUMN "token" DROP DEFAULT;
CREATE UNIQUE INDEX "qr_codes_token_key" ON "qr_codes"("token");
