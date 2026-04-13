import { randomBytes, createHash } from "crypto";
import QRCode from "qrcode";
import { uploadFile, deleteFiles } from "./r2.js";
import { PrismaClient } from "@prisma/client";

const QR_BUCKET = process.env.R2_QR_BUCKET_NAME || "wealth-qr-codes";

/**
 * Generate a unique QR token (32-character hex string).
 * This is just the token — no image generated yet.
 */
export function generateQrToken(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Generate QR tokens for a voucher (bulk creation).
 * Tokens are created in the database with status='available', no images yet.
 * Images will be generated lazily when assigned to users.
 */
export async function generateQrTokensForVoucher(
  prisma: PrismaClient,
  voucherId: string,
  count: number
): Promise<void> {
  const tokens = Array.from({ length: count }, () => generateQrToken());

  await prisma.qrCode.createMany({
    data: tokens.map((token) => ({
      voucherId,
      token,
      status: "available",
    })),
  });
}

/**
 * Generate QR code image and upload to R2.
 * This is called lazily after QR token is assigned to a user.
 * R2 key format: qr-codes/{voucherId}/{qrCodeId}.png
 */
export async function generateAndUploadQrImage(
  voucherId: string,
  qrCodeId: string,
  token: string
): Promise<{ imageUrl: string; imageHash: string }> {
  const buffer = await QRCode.toBuffer(token, {
    type: "png",
    width: 512,
    margin: 2,
    errorCorrectionLevel: "H",
  });

  const imageHash = createHash("sha256").update(buffer).digest("hex");
  const key = `qr-codes/${voucherId}/${qrCodeId}.png`;

  await uploadFile({
    bucket: QR_BUCKET,
    key,
    body: buffer,
    contentType: "image/png"
  });

  return { imageUrl: key, imageHash };
}

/**
 * Legacy function for backward compatibility.
 * Generate a QR code PNG, upload to R2, and return token + metadata.
 * @deprecated Use generateQrTokensForVoucher() + generateAndUploadQrImage() instead
 */
export async function generateQrCode(
  redemptionId: string,
  index: number
): Promise<{ token: string; imageUrl: string; imageHash: string }> {
  const token = randomBytes(16).toString("hex");

  const buffer = await QRCode.toBuffer(token, { type: "png" });
  const imageHash = createHash("sha256").update(buffer).digest("hex");
  const key = `qr-codes/${redemptionId}/${index}.png`;

  await uploadFile({ bucket: QR_BUCKET, key, body: buffer, contentType: "image/png" });

  return { token, imageUrl: key, imageHash };
}

/**
 * Delete a single QR image from R2.
 * Errors are logged but not rethrown.
 */
export async function deleteQrImage(imageUrl: string): Promise<void> {
  if (!imageUrl) return;
  try {
    await deleteFiles(QR_BUCKET, [imageUrl]);
  } catch (err) {
    console.error("[deleteQrImage] Failed:", imageUrl, err);
  }
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
