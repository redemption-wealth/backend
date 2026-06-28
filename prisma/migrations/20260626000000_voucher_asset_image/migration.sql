-- Merchant-uploaded vouchers can now be backed either by a VALUE (code Wealth
-- renders) or by a finished IMAGE file uploaded by the merchant (stored & shown
-- as-is, e.g. to preserve an exact original barcode). Default VALUE keeps every
-- existing row on the current behaviour, so this is backward compatible.

CREATE TYPE "AssetInputType" AS ENUM ('VALUE', 'IMAGE');

ALTER TABLE "vouchers"
  ADD COLUMN "assetInputType" "AssetInputType" NOT NULL DEFAULT 'VALUE';
