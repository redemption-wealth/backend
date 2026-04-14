-- AlterEnum: Rename QrStatus.assigned to QrStatus.redeemed
ALTER TYPE "QrStatus" RENAME VALUE 'assigned' TO 'redeemed';

-- CreateEnum: SlotStatus
CREATE TYPE "SlotStatus" AS ENUM ('available', 'redeemed', 'fully_used');

-- AlterTable: admins - add soft delete and creator tracking
ALTER TABLE "admins" ADD COLUMN "created_by" TEXT;
ALTER TABLE "admins" ADD COLUMN "deleted_at" TIMESTAMP(3);

-- AlterTable: merchants - add soft delete
ALTER TABLE "merchants" ADD COLUMN "deleted_at" TIMESTAMP(3);

-- AlterTable: vouchers - add soft delete, fee snapshot fields, rename columns
ALTER TABLE "vouchers" ADD COLUMN "deleted_at" TIMESTAMP(3);
ALTER TABLE "vouchers" ADD COLUMN "created_by" TEXT;
ALTER TABLE "vouchers" ADD COLUMN "base_price" DECIMAL(15,2);
ALTER TABLE "vouchers" ADD COLUMN "app_fee_rate" DECIMAL(5,2);
ALTER TABLE "vouchers" ADD COLUMN "gas_fee_amount" DECIMAL(15,2);
ALTER TABLE "vouchers" ADD COLUMN "total_price" DECIMAL(15,2);
ALTER TABLE "vouchers" RENAME COLUMN "end_date" TO "expiry_date";
ALTER TABLE "vouchers" RENAME COLUMN "qr_per_redemption" TO "qr_per_slot";

-- Migrate existing data: copy priceIdr to basePrice and totalPrice
UPDATE "vouchers" SET "base_price" = "price_idr", "total_price" = "price_idr", "app_fee_rate" = 3.00, "gas_fee_amount" = 0 WHERE "base_price" IS NULL;

-- Make new columns NOT NULL after data migration
ALTER TABLE "vouchers" ALTER COLUMN "base_price" SET NOT NULL;
ALTER TABLE "vouchers" ALTER COLUMN "app_fee_rate" SET NOT NULL;
ALTER TABLE "vouchers" ALTER COLUMN "gas_fee_amount" SET NOT NULL;
ALTER TABLE "vouchers" ALTER COLUMN "total_price" SET NOT NULL;

-- Drop old priceIdr column
ALTER TABLE "vouchers" DROP COLUMN "price_idr";

-- CreateTable: redemption_slots
CREATE TABLE "redemption_slots" (
    "id" TEXT NOT NULL,
    "voucher_id" TEXT NOT NULL,
    "slot_index" INTEGER NOT NULL,
    "status" "SlotStatus" NOT NULL DEFAULT 'available',
    "redeemed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "redemption_slots_pkey" PRIMARY KEY ("id")
);

-- AlterTable: qr_codes - add slot relationship and redeemed_at
ALTER TABLE "qr_codes" ADD COLUMN "slot_id" TEXT;
ALTER TABLE "qr_codes" ADD COLUMN "qr_number" SMALLINT;
ALTER TABLE "qr_codes" ADD COLUMN "redeemed_at" TIMESTAMP(3);

-- For existing QR codes, create a slot for each voucher and assign QRs
-- This is a data migration to handle existing QR codes
DO $$
DECLARE
    v_record RECORD;
    qr_rec RECORD;
    new_slot_id TEXT;
    qr_counter INTEGER;
    current_qr_number INTEGER;
BEGIN
    -- For each voucher, create slots and assign existing QR codes
    FOR v_record IN SELECT DISTINCT voucher_id FROM qr_codes WHERE slot_id IS NULL LOOP
        qr_counter := 1;

        -- Create one slot for this voucher's existing QRs
        INSERT INTO redemption_slots (id, voucher_id, slot_index, status, created_at, updated_at)
        VALUES (gen_random_uuid(), v_record.voucher_id, qr_counter, 'available', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        RETURNING id INTO new_slot_id;

        -- Assign all QR codes for this voucher to the slot
        current_qr_number := 1;
        FOR qr_rec IN SELECT id FROM qr_codes WHERE voucher_id = v_record.voucher_id AND slot_id IS NULL ORDER BY created_at LOOP
            UPDATE qr_codes
            SET slot_id = new_slot_id, qr_number = current_qr_number
            WHERE id = qr_rec.id;
            current_qr_number := current_qr_number + 1;
        END LOOP;
    END LOOP;
END $$;

-- Make slot_id and qr_number NOT NULL after migration
ALTER TABLE "qr_codes" ALTER COLUMN "slot_id" SET NOT NULL;
ALTER TABLE "qr_codes" ALTER COLUMN "qr_number" SET NOT NULL;

-- AlterTable: app_settings - rename and add new columns
ALTER TABLE "app_settings" RENAME COLUMN "app_fee_percentage" TO "app_fee_rate";
ALTER TABLE "app_settings" RENAME COLUMN "token_contract_address" TO "wealth_contract_address";
ALTER TABLE "app_settings" RENAME COLUMN "treasury_wallet_address" TO "dev_wallet_address";
ALTER TABLE "app_settings" ADD COLUMN "alchemy_rpc_url" TEXT;
ALTER TABLE "app_settings" ADD COLUMN "coingecko_api_key" TEXT;
ALTER TABLE "app_settings" ADD COLUMN "app_fee_updated_by" TEXT;
ALTER TABLE "app_settings" ADD COLUMN "app_fee_updated_at" TIMESTAMP(3);

-- AlterTable: fee_settings - change amountIdr to Decimal
ALTER TABLE "fee_settings" ALTER COLUMN "amount_idr" TYPE DECIMAL(15,2);

-- CreateIndex: redemption_slots
CREATE UNIQUE INDEX "redemption_slots_voucher_id_slot_index_key" ON "redemption_slots"("voucher_id", "slot_index");
CREATE INDEX "redemption_slots_voucher_id_status_idx" ON "redemption_slots"("voucher_id", "status");

-- CreateIndex: qr_codes
CREATE UNIQUE INDEX "qr_codes_slot_id_qr_number_key" ON "qr_codes"("slot_id", "qr_number");
CREATE INDEX "qr_codes_slot_id_idx" ON "qr_codes"("slot_id");

-- Partial unique index for admin-merchant relationship
CREATE UNIQUE INDEX "admins_merchant_unique" ON "admins"("merchant_id") WHERE "merchant_id" IS NOT NULL AND "deleted_at" IS NULL;

-- AddForeignKey: admins
ALTER TABLE "admins" ADD CONSTRAINT "admins_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "admins"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: vouchers
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "admins"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: redemption_slots
ALTER TABLE "redemption_slots" ADD CONSTRAINT "redemption_slots_voucher_id_fkey" FOREIGN KEY ("voucher_id") REFERENCES "vouchers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: qr_codes
ALTER TABLE "qr_codes" ADD CONSTRAINT "qr_codes_slot_id_fkey" FOREIGN KEY ("slot_id") REFERENCES "redemption_slots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: app_settings
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_app_fee_updated_by_fkey" FOREIGN KEY ("app_fee_updated_by") REFERENCES "admins"("id") ON DELETE SET NULL ON UPDATE CASCADE;
