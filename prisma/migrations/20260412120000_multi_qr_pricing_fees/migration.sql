-- AlterTable: Admin.passwordHash nullable (first-login flow)
ALTER TABLE "admins" ALTER COLUMN "password_hash" DROP NOT NULL;

-- AlterTable: Voucher add qrPerRedemption
ALTER TABLE "vouchers" ADD COLUMN "qr_per_redemption" INTEGER NOT NULL DEFAULT 1;

-- AlterTable: QrCode add redemptionId FK
ALTER TABLE "qr_codes" ADD COLUMN "redemption_id" TEXT;

-- AlterTable: Redemption - drop old qr_code_id relation, rename dev_cut_amount, add gas_fee_amount
-- First drop the FK constraint and unique index on qr_code_id
ALTER TABLE "redemptions" DROP CONSTRAINT "redemptions_qr_code_id_fkey";
DROP INDEX "redemptions_qr_code_id_key";
ALTER TABLE "redemptions" DROP COLUMN "qr_code_id";

-- Rename dev_cut_amount to app_fee_amount
ALTER TABLE "redemptions" RENAME COLUMN "dev_cut_amount" TO "app_fee_amount";

-- Add gas_fee_amount
ALTER TABLE "redemptions" ADD COLUMN "gas_fee_amount" DECIMAL(36,18) NOT NULL DEFAULT 0;

-- AlterTable: AppSettings rename dev_cut_percentage to app_fee_percentage
ALTER TABLE "app_settings" RENAME COLUMN "dev_cut_percentage" TO "app_fee_percentage";

-- CreateTable: FeeSetting
CREATE TABLE "fee_settings" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "amount_idr" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fee_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: QrCode.redemptionId
CREATE INDEX "qr_codes_redemption_id_idx" ON "qr_codes"("redemption_id");

-- AddForeignKey: QrCode.redemptionId -> Redemption.id
ALTER TABLE "qr_codes" ADD CONSTRAINT "qr_codes_redemption_id_fkey" FOREIGN KEY ("redemption_id") REFERENCES "redemptions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
