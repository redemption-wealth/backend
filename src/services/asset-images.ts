import AdmZip from "adm-zip";
import { createHash } from "crypto";
import { fileTypeFromBuffer } from "file-type";
import { uploadFile } from "./r2.js";

const QR_BUCKET = process.env.R2_QR_BUCKET_NAME || "wealth-qr-codes";

// Safety limits for merchant-uploaded image assets.
export const MAX_IMAGE_BYTES = 1 * 1024 * 1024; // 1 MB per image
export const MAX_IMAGES = 1000; // per voucher
export const MAX_TOTAL_UPLOAD_BYTES = 100 * 1024 * 1024; // 100 MB total
export const ALLOWED_IMAGE_EXTS = ["png", "jpg"] as const; // file-type reports jpeg as "jpg"

export interface ImageEntry {
  name: string;
  data: Buffer;
}

/**
 * Extract image entries from a ZIP buffer, sorted by filename (natural order:
 * 1.png, 2.png, 10.png …). Ignores folders, hidden/system files (.DS_Store,
 * __MACOSX), and anything without an image extension. Content is verified later.
 */
export function extractZipImages(zipBuffer: Buffer): ImageEntry[] {
  const zip = new AdmZip(zipBuffer);
  const entries: ImageEntry[] = zip
    .getEntries()
    .filter((e) => !e.isDirectory)
    .map((e) => ({
      name: e.entryName.split("/").pop() ?? e.entryName,
      data: e.getData(),
    }))
    .filter(
      (e) =>
        !e.name.startsWith(".") &&
        !e.name.startsWith("__") &&
        /\.(png|jpe?g)$/i.test(e.name),
    );

  entries.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }),
  );
  return entries;
}

export interface ImageValidationInput {
  entries: ImageEntry[];
  totalStock: number;
  qrPerSlot: number;
}

export interface ImageValidationResult {
  ok: boolean;
  expected: number;
  received: number;
  errors: string[];
}

/**
 * Validate a batch of image entries: exact count (totalStock × qrPerSlot), max
 * count, per-image size & real type (PNG/JPG by content), total size, and no
 * duplicate images (by content hash). Up to 5 sample errors per category.
 */
export async function validateImageUpload(
  input: ImageValidationInput,
): Promise<ImageValidationResult> {
  const { entries, totalStock, qrPerSlot } = input;
  const expected = totalStock * qrPerSlot;
  const received = entries.length;
  const errors: string[] = [];

  if (received > MAX_IMAGES) {
    errors.push(`Jumlah gambar (${received}) melebihi batas maksimal ${MAX_IMAGES}`);
  }
  if (received !== expected) {
    errors.push(
      `Jumlah gambar (${received}) harus tepat ${expected} (= stok ${totalStock} × ${qrPerSlot} per slot)`,
    );
  }

  let totalBytes = 0;
  const seen = new Set<string>();
  let dup = 0;
  let badType = 0;
  let tooBig = 0;

  for (const e of entries) {
    totalBytes += e.data.length;
    if (e.data.length > MAX_IMAGE_BYTES) {
      tooBig += 1;
      if (tooBig <= 5) errors.push(`${e.name}: ukuran melebihi 1 MB`);
      continue;
    }
    const ft = await fileTypeFromBuffer(e.data);
    if (!ft || !ALLOWED_IMAGE_EXTS.includes(ft.ext as (typeof ALLOWED_IMAGE_EXTS)[number])) {
      badType += 1;
      if (badType <= 5) errors.push(`${e.name}: bukan file gambar PNG/JPG`);
      continue;
    }
    const hash = createHash("sha256").update(e.data).digest("hex");
    if (seen.has(hash)) {
      dup += 1;
      if (dup <= 5) errors.push(`${e.name}: gambar duplikat`);
    } else {
      seen.add(hash);
    }
  }

  if (totalBytes > MAX_TOTAL_UPLOAD_BYTES) {
    errors.push("Total ukuran upload melebihi 100 MB");
  }

  return { ok: errors.length === 0, expected, received, errors };
}

/**
 * Upload a pre-rendered merchant image to R2 under a per-voucher key (the image
 * exists at creation, before any redemption). Returns the storage key + a hash
 * that includes the key so identical images across vouchers never collide.
 */
export async function storeVoucherAssetImage(
  voucherId: string,
  slotIndex: number,
  qrNumber: number,
  buffer: Buffer,
): Promise<{ imageUrl: string; imageHash: string }> {
  const ft = await fileTypeFromBuffer(buffer);
  const ext = ft?.ext === "jpg" ? "jpg" : "png";
  const mime = ft?.mime ?? "image/png";
  const key = `voucher-assets/${voucherId}/${slotIndex}-${qrNumber}.${ext}`;
  const imageHash = createHash("sha256").update(buffer).update(key).digest("hex");
  await uploadFile({ bucket: QR_BUCKET, key, body: buffer, contentType: mime });
  return { imageUrl: key, imageHash };
}
