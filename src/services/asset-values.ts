// Single source of truth for voucher asset formats, barcode symbologies, and the
// validation of merchant-uploaded values. Both the create route (authoritative
// validation) and the asset renderer (symbology → bwip-js encoder id) import from
// here, so the rules live in exactly one place.

export const VOUCHER_FORMATS = ["QR", "CODE", "BARCODE"] as const;
export type VoucherFormat = (typeof VOUCHER_FORMATS)[number];

export const ASSET_SOURCES = ["WEALTH_GENERATED", "MERCHANT_UPLOADED"] as const;
export type AssetSource = (typeof ASSET_SOURCES)[number];

// Supported barcode symbologies (v1). `bcid` is the bwip-js encoder id.
export const BARCODE_SYMBOLOGIES = {
  CODE128: { bcid: "code128", label: "Code 128" },
  EAN13: { bcid: "ean13", label: "EAN-13" },
} as const;
export type BarcodeSymbology = keyof typeof BARCODE_SYMBOLOGIES;
export const BARCODE_SYMBOLOGY_KEYS = Object.keys(
  BARCODE_SYMBOLOGIES,
) as BarcodeSymbology[];

// Generous upper bound — QR can hold long payloads; codes/barcodes are short.
export const MAX_ASSET_VALUE_LENGTH = 512;

/**
 * Validate a single asset value for a given format/symbology.
 * Returns a human-readable error string, or null when the value is acceptable.
 */
export function validateAssetValue(
  format: VoucherFormat,
  symbology: BarcodeSymbology | null | undefined,
  value: string,
): string | null {
  const v = (value ?? "").trim();
  if (!v) return "Nilai kosong";
  if (v.length > MAX_ASSET_VALUE_LENGTH) {
    return `Nilai melebihi ${MAX_ASSET_VALUE_LENGTH} karakter`;
  }
  if (format === "BARCODE") {
    if (!symbology || !(symbology in BARCODE_SYMBOLOGIES)) {
      return "Simbologi barcode tidak valid";
    }
    if (symbology === "EAN13" && !/^\d{12,13}$/.test(v)) {
      return "EAN-13 harus 12–13 digit angka";
    }
    if (symbology === "CODE128" && !/^[\x20-\x7E]+$/.test(v)) {
      return "Code 128 hanya menerima karakter ASCII";
    }
  }
  return null;
}

export interface UploadValidationInput {
  format: VoucherFormat;
  symbology?: BarcodeSymbology | null;
  values: string[];
  totalStock: number;
  qrPerSlot: number;
}

export interface UploadValidationResult {
  ok: boolean;
  expected: number;
  received: number;
  errors: string[];
}

/**
 * Validate a full batch of uploaded values against the voucher's stock plan.
 * Enforces: exact count (totalStock × qrPerSlot), no empty values, no duplicates,
 * and per-value format/symbology rules. Up to 5 sample errors are reported per
 * category to keep the response bounded for large uploads.
 */
export function validateUploadedValues(
  input: UploadValidationInput,
): UploadValidationResult {
  const { format, symbology, values, totalStock, qrPerSlot } = input;
  const expected = totalStock * qrPerSlot;
  const received = values.length;
  const errors: string[] = [];

  if (received !== expected) {
    errors.push(
      `Jumlah nilai (${received}) harus tepat ${expected} (= stok ${totalStock} × ${qrPerSlot} per slot)`,
    );
  }

  const seen = new Set<string>();
  let emptyCount = 0;
  let dupCount = 0;
  let invalidCount = 0;

  values.forEach((raw, i) => {
    const v = (raw ?? "").trim();
    const err = validateAssetValue(format, symbology, v);
    if (err === "Nilai kosong") {
      emptyCount += 1;
      return;
    }
    if (err) {
      invalidCount += 1;
      if (invalidCount <= 5) errors.push(`Baris ${i + 1}: ${err}`);
      return;
    }
    if (seen.has(v)) {
      dupCount += 1;
      if (dupCount <= 5) errors.push(`Baris ${i + 1}: nilai duplikat "${v}"`);
    } else {
      seen.add(v);
    }
  });

  if (emptyCount > 0) errors.push(`${emptyCount} nilai kosong`);
  if (dupCount > 0) errors.push(`${dupCount} nilai duplikat`);

  return { ok: errors.length === 0, expected, received, errors };
}
