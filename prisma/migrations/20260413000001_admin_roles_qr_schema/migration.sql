-- Step 2: Use 'manager' enum value (after it has been committed in prior migration)

-- Change default role from admin to manager
ALTER TABLE "admins" ALTER COLUMN "role" SET DEFAULT 'manager';

-- AlterTable: Admin - add merchantId FK (nullable)
ALTER TABLE "admins" ADD COLUMN "merchant_id" TEXT;

-- CreateIndex: Admin.merchantId
CREATE INDEX "admins_merchant_id_idx" ON "admins"("merchant_id");

-- AddForeignKey: Admin.merchantId -> Merchant.id (SET NULL on merchant delete)
ALTER TABLE "admins" ADD CONSTRAINT "admins_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable: QrCode - add token (unique, nullable)
ALTER TABLE "qr_codes" ADD COLUMN "token" TEXT;

-- CreateIndex: QrCode.token (unique)
CREATE UNIQUE INDEX "qr_codes_token_key" ON "qr_codes"("token");

-- AlterTable: QrCode - add scannedByAdminId FK (nullable)
ALTER TABLE "qr_codes" ADD COLUMN "scanned_by_admin_id" TEXT;

-- AddForeignKey: QrCode.scannedByAdminId -> Admin.id
ALTER TABLE "qr_codes" ADD CONSTRAINT "qr_codes_scanned_by_admin_id_fkey" FOREIGN KEY ("scanned_by_admin_id") REFERENCES "admins"("id") ON DELETE SET NULL ON UPDATE CASCADE;
