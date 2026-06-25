import { randomBytes } from "crypto";
import { renderAssetImage, storeAssetImage } from "./asset-renderer.js";
import { deleteFiles } from "./r2.js";
import type { VoucherFormat, BarcodeSymbology } from "./asset-values.js";

const QR_BUCKET = process.env.R2_QR_BUCKET_NAME || "wealth-qr-codes";

/**
 * Wealth-generated flow: mint a random token, render it as a QR, upload to R2.
 * The token is encoded in the QR image — admin scans or manually enters it.
 * Signature/return are unchanged so existing callers/mocks keep working.
 */
export async function generateQrCode(
  redemptionId: string,
  index: number
): Promise<{ token: string; imageUrl: string; imageHash: string }> {
  const token = randomBytes(16).toString("hex");
  const buffer = await renderAssetImage({ format: "QR", value: token });
  // QR always renders a buffer; the non-null assertion documents that invariant.
  const { imageUrl, imageHash } = await storeAssetImage(redemptionId, index, buffer!);
  return { token, imageUrl, imageHash };
}

/**
 * Merchant-uploaded flow: render the pre-stored value for its format and upload.
 * CODE has no image (the value is shown as text) → returns nulls so the caller
 * leaves imageHash untouched. The value itself is never (re)generated here.
 */
export async function generateUploadedAsset(
  redemptionId: string,
  index: number,
  opts: { format: VoucherFormat; value: string; symbology: BarcodeSymbology | null }
): Promise<{ imageUrl: string | null; imageHash: string | null }> {
  const buffer = await renderAssetImage({
    format: opts.format,
    value: opts.value,
    symbology: opts.symbology,
  });
  if (!buffer) return { imageUrl: null, imageHash: null };
  const { imageUrl, imageHash } = await storeAssetImage(redemptionId, index, buffer);
  return { imageUrl, imageHash };
}

/**
 * Delete asset PNG files from R2.
 * Errors are logged but not rethrown — caller decides whether to surface them.
 */
export async function deleteQrFiles(imageUrls: string[]): Promise<void> {
  if (imageUrls.length === 0) return;
  const result = await deleteFiles(QR_BUCKET, imageUrls);
  if (result.errors.length > 0) {
    console.error("[QR Generator] R2 delete errors:", result.errors);
  }
}
