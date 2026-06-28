import { describe, test, expect, vi, beforeAll } from "vitest";
import AdmZip from "adm-zip";

const uploadFileMock = vi.fn(async () => ({ success: true, key: "k" }));
vi.mock("@/services/r2.js", () => ({
  uploadFile: (...args: unknown[]) => uploadFileMock(...args),
}));

import {
  extractZipImages,
  validateImageUpload,
  storeVoucherAssetImage,
  MAX_IMAGE_BYTES,
} from "@/services/asset-images.js";
import { renderAssetImage } from "@/services/asset-renderer.js";

let pngA: Buffer;
let pngB: Buffer;

beforeAll(async () => {
  pngA = (await renderAssetImage({ format: "QR", value: "AAA" }))!;
  pngB = (await renderAssetImage({ format: "QR", value: "BBB" }))!;
});

describe("extractZipImages", () => {
  test("returns image entries sorted by natural filename, ignoring junk", () => {
    const zip = new AdmZip();
    zip.addFile("10.png", pngA);
    zip.addFile("2.png", pngB);
    zip.addFile("1.png", pngA);
    zip.addFile(".DS_Store", Buffer.from("junk"));
    zip.addFile("notes.txt", Buffer.from("hello"));
    const out = extractZipImages(zip.toBuffer());
    expect(out.map((e) => e.name)).toEqual(["1.png", "2.png", "10.png"]);
  });
});

describe("validateImageUpload", () => {
  test("passes for exact count of unique valid images", async () => {
    const entries = [
      { name: "1.png", data: pngA },
      { name: "2.png", data: pngB },
    ];
    const r = await validateImageUpload({ entries, totalStock: 2, qrPerSlot: 1 });
    expect(r.ok).toBe(true);
    expect(r.errors).toHaveLength(0);
  });

  test("fails on count mismatch", async () => {
    const r = await validateImageUpload({
      entries: [{ name: "1.png", data: pngA }],
      totalStock: 2,
      qrPerSlot: 1,
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/harus tepat 2/);
  });

  test("flags duplicate images", async () => {
    const r = await validateImageUpload({
      entries: [
        { name: "1.png", data: pngA },
        { name: "2.png", data: pngA },
      ],
      totalStock: 2,
      qrPerSlot: 1,
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/duplikat/);
  });

  test("rejects non-image content even with .png name", async () => {
    const r = await validateImageUpload({
      entries: [{ name: "fake.png", data: Buffer.from("not really an image") }],
      totalStock: 1,
      qrPerSlot: 1,
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/bukan file gambar/);
  });

  test("rejects oversized image", async () => {
    const big = Buffer.alloc(MAX_IMAGE_BYTES + 1, 1);
    const r = await validateImageUpload({
      entries: [{ name: "big.png", data: big }],
      totalStock: 1,
      qrPerSlot: 1,
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/melebihi 1 MB/);
  });
});

describe("storeVoucherAssetImage", () => {
  test("uploads under a per-voucher key with a key-bound hash", async () => {
    uploadFileMock.mockClear();
    const { imageUrl, imageHash } = await storeVoucherAssetImage("vch-1", 3, 1, pngA);
    expect(imageUrl).toBe("voucher-assets/vch-1/3-1.png");
    expect(imageHash).toMatch(/^[a-f0-9]{64}$/);
    expect(uploadFileMock).toHaveBeenCalledOnce();
    const arg = uploadFileMock.mock.calls[0][0] as { key: string; contentType: string };
    expect(arg.key).toBe("voucher-assets/vch-1/3-1.png");
    expect(arg.contentType).toBe("image/png");
  });
});
