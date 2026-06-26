import { createHash } from "crypto";
import qrcode from "qrcode";
import bwipjs from "bwip-js/node";
import { uploadFile } from "./r2.js";
import {
  BARCODE_SYMBOLOGIES,
  type VoucherFormat,
  type BarcodeSymbology,
} from "./asset-values.js";

const QR_BUCKET = process.env.R2_QR_BUCKET_NAME || "wealth-qr-codes";

/**
 * Render an asset value to a PNG buffer based on its format.
 * - QR      → encode the value as a QR code
 * - BARCODE → encode the value with the chosen symbology (bwip-js)
 * - CODE    → no image (the value is shown as plain text), returns null
 *
 * The `value` is the payload that ends up behind the asset: a Wealth-generated
 * token (WEALTH_GENERATED) or the merchant-uploaded value (MERCHANT_UPLOADED).
 */
export async function renderAssetImage(params: {
  format: VoucherFormat;
  value: string;
  symbology?: BarcodeSymbology | null;
}): Promise<Buffer | null> {
  const { format, value, symbology } = params;

  if (format === "CODE") return null;

  if (format === "QR") {
    return qrcode.toBuffer(value, { type: "png" });
  }

  // BARCODE
  const sym = symbology ? BARCODE_SYMBOLOGIES[symbology] : undefined;
  if (!sym) {
    throw new Error(`Unsupported barcode symbology: ${String(symbology)}`);
  }
  return bwipjs.toBuffer({
    bcid: sym.bcid,
    text: value,
    scale: 3,
    height: 10,
    includetext: true,
    textxalign: "center",
  });
}

/**
 * Upload a rendered PNG to R2 and return its key + content hash.
 * Deterministic key (qr-codes/{redemptionId}/{index}.png) keeps it idempotent on
 * retry — same as the original Wealth QR flow.
 */
export async function storeAssetImage(
  redemptionId: string,
  index: number,
  buffer: Buffer,
): Promise<{ imageUrl: string; imageHash: string }> {
  const key = `qr-codes/${redemptionId}/${index}.png`;
  // Hash includes the (unique) storage key so two assets that render to an
  // identical image — e.g. the same merchant-uploaded value reused across
  // different vouchers — don't collide on the `imageHash` unique constraint.
  const imageHash = createHash("sha256").update(buffer).update(key).digest("hex");
  await uploadFile({ bucket: QR_BUCKET, key, body: buffer, contentType: "image/png" });
  return { imageUrl: key, imageHash };
}
