import { randomBytes, createHash } from "crypto";
import qrcode from "qrcode";
import { uploadFile, deleteFiles } from "./r2.js";

const QR_BUCKET = process.env.R2_QR_BUCKET_NAME || "wealth-qr-codes";

/**
 * Generate a QR code PNG, upload to R2, and return token + metadata.
 * The token (random hex) is encoded in the QR image — admin scans or manually enters it.
 * R2 key format: qr-codes/{redemptionId}/{index}.png (deterministic — idempotent on retry)
 */
export async function generateQrCode(
  redemptionId: string,
  index: number
): Promise<{ token: string; imageUrl: string; imageHash: string }> {
  const token = randomBytes(16).toString("hex");

  const buffer = await qrcode.toBuffer(token, { type: "png" });
  const imageHash = createHash("sha256").update(buffer).digest("hex");
  const key = `qr-codes/${redemptionId}/${index}.png`;

  await uploadFile({ bucket: QR_BUCKET, key, body: buffer, contentType: "image/png" });

  return { token, imageUrl: key, imageHash };
}

/**
 * Delete QR PNG files from R2.
 * Errors are logged but not rethrown — caller decides whether to surface them.
 */
export async function deleteQrFiles(imageUrls: string[]): Promise<void> {
  if (imageUrls.length === 0) return;
  const result = await deleteFiles(QR_BUCKET, imageUrls);
  if (result.errors.length > 0) {
    console.error("[QR Generator] R2 delete errors:", result.errors);
  }
}
