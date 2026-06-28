import { describe, test, expect } from "vitest";
import {
  validateAssetValue,
  validateUploadedValues,
  BARCODE_SYMBOLOGY_KEYS,
  MAX_ASSET_VALUE_LENGTH,
} from "@/services/asset-values.js";

describe("validateAssetValue", () => {
  test("rejects empty / whitespace value", () => {
    expect(validateAssetValue("CODE", null, "")).toBe("Nilai kosong");
    expect(validateAssetValue("CODE", null, "   ")).toBe("Nilai kosong");
  });

  test("rejects value over max length", () => {
    const long = "a".repeat(MAX_ASSET_VALUE_LENGTH + 1);
    expect(validateAssetValue("QR", null, long)).toMatch(/melebihi/);
  });

  test("CODE accepts any non-empty string", () => {
    expect(validateAssetValue("CODE", null, "PROMO-2026")).toBeNull();
  });

  test("QR accepts arbitrary payload", () => {
    expect(validateAssetValue("QR", null, "https://x.test/redeem?id=abc")).toBeNull();
  });

  test("BARCODE requires a known symbology", () => {
    expect(validateAssetValue("BARCODE", null, "123")).toMatch(/Simbologi/);
    // @ts-expect-error invalid symbology on purpose
    expect(validateAssetValue("BARCODE", "PDF417", "123")).toMatch(/Simbologi/);
  });

  test("EAN13 must be 12-13 digits", () => {
    expect(validateAssetValue("BARCODE", "EAN13", "123456789012")).toBeNull();
    expect(validateAssetValue("BARCODE", "EAN13", "1234567890123")).toBeNull();
    expect(validateAssetValue("BARCODE", "EAN13", "12345")).toMatch(/EAN-13/);
    expect(validateAssetValue("BARCODE", "EAN13", "abcdefghijkl")).toMatch(/EAN-13/);
  });

  test("CODE128 accepts the Loket-style long numeric value", () => {
    expect(validateAssetValue("BARCODE", "CODE128", "14804667519524101")).toBeNull();
  });

  test("exposes the v1 symbology set", () => {
    expect(BARCODE_SYMBOLOGY_KEYS).toEqual(["CODE128", "EAN13"]);
  });
});

describe("validateUploadedValues", () => {
  const base = { format: "CODE" as const, totalStock: 10, qrPerSlot: 2 };

  test("passes when count is exactly totalStock × qrPerSlot and unique", () => {
    const values = Array.from({ length: 20 }, (_, i) => `CODE-${i}`);
    const res = validateUploadedValues({ ...base, values });
    expect(res.ok).toBe(true);
    expect(res.expected).toBe(20);
    expect(res.received).toBe(20);
    expect(res.errors).toHaveLength(0);
  });

  test("fails when count mismatches (brainstorm: upload 20 → stock 10)", () => {
    const values = Array.from({ length: 19 }, (_, i) => `CODE-${i}`);
    const res = validateUploadedValues({ ...base, values });
    expect(res.ok).toBe(false);
    expect(res.errors.join(" ")).toMatch(/Jumlah nilai \(19\) harus tepat 20/);
  });

  test("flags duplicates", () => {
    const values = Array.from({ length: 20 }, (_, i) => (i === 19 ? "CODE-0" : `CODE-${i}`));
    const res = validateUploadedValues({ ...base, values });
    expect(res.ok).toBe(false);
    expect(res.errors.join(" ")).toMatch(/duplikat/);
  });

  test("flags empty values", () => {
    const values = Array.from({ length: 20 }, (_, i) => (i === 5 ? "" : `CODE-${i}`));
    const res = validateUploadedValues({ ...base, values });
    expect(res.ok).toBe(false);
    expect(res.errors.join(" ")).toMatch(/kosong/);
  });

  test("validates barcode symbology per value", () => {
    const res = validateUploadedValues({
      format: "BARCODE",
      symbology: "EAN13",
      totalStock: 2,
      qrPerSlot: 1,
      values: ["123456789012", "not-a-barcode"],
    });
    expect(res.ok).toBe(false);
    expect(res.errors.join(" ")).toMatch(/EAN-13/);
  });
});
