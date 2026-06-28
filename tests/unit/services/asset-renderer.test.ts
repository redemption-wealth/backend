import { describe, test, expect, vi, beforeEach } from "vitest";

const uploadFileMock = vi.fn(async () => ({ success: true, key: "k" }));
vi.mock("@/services/r2.js", () => ({
  uploadFile: (...args: unknown[]) => uploadFileMock(...args),
}));

import { renderAssetImage, storeAssetImage } from "@/services/asset-renderer.js";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // \x89PNG

function isPng(buf: Buffer | null): boolean {
  return !!buf && buf.subarray(0, 4).equals(PNG_MAGIC);
}

describe("renderAssetImage", () => {
  test("CODE renders no image (null)", async () => {
    expect(await renderAssetImage({ format: "CODE", value: "PROMO-1" })).toBeNull();
  });

  test("QR renders a PNG buffer", async () => {
    const buf = await renderAssetImage({ format: "QR", value: "abc123" });
    expect(isPng(buf)).toBe(true);
  });

  test("BARCODE/CODE128 renders a PNG buffer", async () => {
    const buf = await renderAssetImage({
      format: "BARCODE",
      symbology: "CODE128",
      value: "14804667519524101",
    });
    expect(isPng(buf)).toBe(true);
  });

  test("BARCODE/EAN13 renders a PNG buffer", async () => {
    const buf = await renderAssetImage({
      format: "BARCODE",
      symbology: "EAN13",
      value: "123456789012",
    });
    expect(isPng(buf)).toBe(true);
  });

  test("BARCODE without a valid symbology throws", async () => {
    await expect(
      renderAssetImage({ format: "BARCODE", value: "123", symbology: null }),
    ).rejects.toThrow(/symbology/i);
  });
});

describe("storeAssetImage", () => {
  beforeEach(() => uploadFileMock.mockClear());

  test("uploads with deterministic key and returns sha256 hash", async () => {
    const buffer = Buffer.from("hello-png");
    const { imageUrl, imageHash } = await storeAssetImage("redemption-1", 2, buffer);
    expect(imageUrl).toBe("qr-codes/redemption-1/2.png");
    expect(imageHash).toMatch(/^[a-f0-9]{64}$/);
    expect(uploadFileMock).toHaveBeenCalledOnce();
    const arg = uploadFileMock.mock.calls[0][0] as { key: string; contentType: string };
    expect(arg.key).toBe("qr-codes/redemption-1/2.png");
    expect(arg.contentType).toBe("image/png");
  });

  test("same image bytes at different keys produce different hashes (no collision)", async () => {
    const buffer = Buffer.from("identical-image");
    const a = await storeAssetImage("redemption-A", 1, buffer);
    const b = await storeAssetImage("redemption-B", 1, buffer);
    expect(a.imageHash).not.toBe(b.imageHash);
  });
});
