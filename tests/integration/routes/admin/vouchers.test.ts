import { describe, test, expect, vi } from "vitest";
import AdmZip from "adm-zip";
import { testPrisma } from "../../../setup.integration.js";
import { createFixtures } from "../../../helpers/fixtures.js";
import { jsonPost, jsonPut, authDelete, multipartPost } from "../../../helpers/request.js";
import { renderAssetImage } from "@/services/asset-renderer.js";

// Don't hit real R2 when storing uploaded images during create.
vi.mock("@/services/r2.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/r2.js")>();
  return { ...actual, uploadFile: vi.fn(async () => ({ success: true, key: "k" })) };
});

async function zipOf(count: number): Promise<Blob> {
  const zip = new AdmZip();
  for (let i = 1; i <= count; i++) {
    const png = await renderAssetImage({ format: "BARCODE", value: `${i}00000000000`, symbology: "CODE128" });
    zip.addFile(`${i}.png`, png!);
  }
  return new Blob([zip.toBuffer()]);
}
import {
  createTestAdminToken,
  createTestOwnerToken,
  createTestManagerToken,
} from "../../../helpers/admin-session.js";

const fixtures = createFixtures(testPrisma);

async function createAdminWithToken(
  role: "admin" | "owner" | "manager" = "owner",
  merchantId?: string,
) {
  const admin = await fixtures.createAdmin({ role, merchantId });
  const token =
    role === "owner"
      ? await createTestOwnerToken({ id: admin.id, email: admin.email })
      : role === "manager"
        ? await createTestManagerToken({ id: admin.id, email: admin.email })
        : await createTestAdminToken({ id: admin.id, email: admin.email });
  return { admin, token };
}

describe("POST /api/admin/vouchers", () => {
  test("creates voucher with valid data", async () => {
    const { admin, token } = await createAdminWithToken();
    const merchant = await fixtures.createMerchant(admin.id);
    await fixtures.createAppSettings({ gasFeeAmount: 500 });

    const res = await jsonPost("/api/admin/vouchers", {
      merchantId: merchant.id,
      title: "Test Voucher",
      startDate: "2026-01-01",
      expiryDate: "2026-12-31",
      totalStock: 10,
      basePrice: 25000,
    }, token);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.voucher.remainingStock).toBe(10);
    expect(body.voucher.qrPerSlot).toBe(1);
    expect(body.voucher.appFeeRate).toBeDefined();
    expect(body.voucher.gasFeeAmount).toBeDefined();
    expect(body.voucher.totalPrice).toBeDefined();
  });

  test("returns 400 for expiryDate < startDate", async () => {
    const { admin, token } = await createAdminWithToken();
    const merchant = await fixtures.createMerchant(admin.id);
    await fixtures.createAppSettings({ gasFeeAmount: 500 });

    const res = await jsonPost("/api/admin/vouchers", {
      merchantId: merchant.id,
      title: "Bad Dates",
      startDate: "2026-12-31",
      expiryDate: "2026-01-01",
      totalStock: 10,
      basePrice: 25000,
    }, token);
    expect(res.status).toBe(400);
  });

  test("returns 400 for negative totalStock", async () => {
    const { admin, token } = await createAdminWithToken();
    const merchant = await fixtures.createMerchant(admin.id);
    await fixtures.createAppSettings({ gasFeeAmount: 500 });

    const res = await jsonPost("/api/admin/vouchers", {
      merchantId: merchant.id,
      title: "Bad Stock",
      startDate: "2026-01-01",
      expiryDate: "2026-12-31",
      totalStock: -1,
      basePrice: 25000,
    }, token);
    expect(res.status).toBe(400);
  });

  test("accepts qrPerSlot = 2", async () => {
    const { admin, token } = await createAdminWithToken();
    const merchant = await fixtures.createMerchant(admin.id);
    await fixtures.createAppSettings({ gasFeeAmount: 500 });

    const res = await jsonPost("/api/admin/vouchers", {
      merchantId: merchant.id,
      title: "Multi-QR",
      startDate: "2026-01-01",
      expiryDate: "2026-12-31",
      totalStock: 10,
      basePrice: 50000,
      qrPerSlot: 2,
    }, token);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.voucher.qrPerSlot).toBe(2);
  });

  test("creates MERCHANT_UPLOADED + CODE voucher and stores values per slot", async () => {
    const { admin, token } = await createAdminWithToken();
    const merchant = await fixtures.createMerchant(admin.id);
    await fixtures.createAppSettings({ gasFeeAmount: 500 });

    const res = await jsonPost("/api/admin/vouchers", {
      merchantId: merchant.id,
      title: "Uploaded Codes",
      startDate: "2026-01-01",
      expiryDate: "2026-12-31",
      totalStock: 2,
      basePrice: 25000,
      qrPerSlot: 2,
      assetSource: "MERCHANT_UPLOADED",
      format: "CODE",
      values: ["AAA", "BBB", "CCC", "DDD"],
    }, token);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.voucher.assetSource).toBe("MERCHANT_UPLOADED");
    expect(body.voucher.format).toBe("CODE");

    const qrs = await testPrisma.qrCode.findMany({
      where: { voucherId: body.voucher.id },
      orderBy: [{ slotId: "asc" }, { qrNumber: "asc" }],
    });
    expect(qrs).toHaveLength(4);
    expect(new Set(qrs.map((q) => q.value))).toEqual(new Set(["AAA", "BBB", "CCC", "DDD"]));
  });

  test("returns 422 when uploaded value count mismatches stock × qrPerSlot", async () => {
    const { admin, token } = await createAdminWithToken();
    const merchant = await fixtures.createMerchant(admin.id);
    await fixtures.createAppSettings({ gasFeeAmount: 500 });

    const res = await jsonPost("/api/admin/vouchers", {
      merchantId: merchant.id,
      title: "Mismatch",
      startDate: "2026-01-01",
      expiryDate: "2026-12-31",
      totalStock: 10,
      basePrice: 25000,
      qrPerSlot: 2,
      assetSource: "MERCHANT_UPLOADED",
      format: "CODE",
      values: Array.from({ length: 19 }, (_, i) => `C-${i}`), // need 20
    }, token);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe("UPLOAD_VALIDATION_FAILED");
  });

  test("returns 422 for duplicate uploaded values", async () => {
    const { admin, token } = await createAdminWithToken();
    const merchant = await fixtures.createMerchant(admin.id);
    await fixtures.createAppSettings({ gasFeeAmount: 500 });

    const res = await jsonPost("/api/admin/vouchers", {
      merchantId: merchant.id,
      title: "Dupes",
      startDate: "2026-01-01",
      expiryDate: "2026-12-31",
      totalStock: 2,
      basePrice: 25000,
      qrPerSlot: 1,
      assetSource: "MERCHANT_UPLOADED",
      format: "CODE",
      values: ["SAME", "SAME"],
    }, token);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe("UPLOAD_VALIDATION_FAILED");
  });

  test("creates MERCHANT_UPLOADED + IMAGE voucher from a ZIP (multipart)", async () => {
    const { admin, token } = await createAdminWithToken();
    const merchant = await fixtures.createMerchant(admin.id);
    await fixtures.createAppSettings({ gasFeeAmount: 500 });

    const form = new FormData();
    form.set("merchantId", merchant.id);
    form.set("title", "Uploaded Images");
    form.set("startDate", "2026-01-01");
    form.set("expiryDate", "2026-12-31");
    form.set("totalStock", "2");
    form.set("basePrice", "25000");
    form.set("qrPerSlot", "1");
    form.set("format", "BARCODE");
    form.set("images", await zipOf(2), "barcodes.zip");

    const res = await multipartPost("/api/admin/vouchers", form, token);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.voucher.assetInputType).toBe("IMAGE");
    expect(body.voucher.assetSource).toBe("MERCHANT_UPLOADED");

    const qrs = await testPrisma.qrCode.findMany({ where: { voucherId: body.voucher.id } });
    expect(qrs).toHaveLength(2);
    expect(qrs.every((q) => q.imageUrl?.startsWith("voucher-assets/"))).toBe(true);
    expect(qrs.every((q) => q.value === null)).toBe(true);
  });

  test("returns 422 when image count mismatches stock × qrPerSlot", async () => {
    const { admin, token } = await createAdminWithToken();
    const merchant = await fixtures.createMerchant(admin.id);
    await fixtures.createAppSettings({ gasFeeAmount: 500 });

    const form = new FormData();
    form.set("merchantId", merchant.id);
    form.set("title", "Too Few Images");
    form.set("startDate", "2026-01-01");
    form.set("expiryDate", "2026-12-31");
    form.set("totalStock", "3");
    form.set("basePrice", "25000");
    form.set("qrPerSlot", "1");
    form.set("format", "BARCODE");
    form.set("images", await zipOf(2), "barcodes.zip"); // need 3

    const res = await multipartPost("/api/admin/vouchers", form, token);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe("IMAGE_VALIDATION_FAILED");
  });

  test("returns 400 for WEALTH_GENERATED with non-QR format", async () => {
    const { admin, token } = await createAdminWithToken();
    const merchant = await fixtures.createMerchant(admin.id);
    await fixtures.createAppSettings({ gasFeeAmount: 500 });

    const res = await jsonPost("/api/admin/vouchers", {
      merchantId: merchant.id,
      title: "Bad Source",
      startDate: "2026-01-01",
      expiryDate: "2026-12-31",
      totalStock: 5,
      basePrice: 25000,
      assetSource: "WEALTH_GENERATED",
      format: "BARCODE",
    }, token);
    expect(res.status).toBe(400);
  });
});

describe("PUT /api/admin/vouchers/:id", () => {
  test("updates allowed fields", async () => {
    const { admin, token } = await createAdminWithToken();
    const merchant = await fixtures.createMerchant(admin.id);
    const { voucher } = await fixtures.createVoucherWithQrCodes(merchant.id, 3);

    const res = await jsonPut(`/api/admin/vouchers/${voucher.id}`, {
      title: "Updated Title",
    }, token);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.voucher.title).toBe("Updated Title");
  });

  test("returns 404 for non-existent voucher", async () => {
    const { token } = await createAdminWithToken();
    const res = await jsonPut("/api/admin/vouchers/550e8400-e29b-41d4-a716-446655440000", {
      title: "Nope",
    }, token);
    expect(res.status).toBe(404);
  });

  test("totalStock is immutable — update ignores it", async () => {
    const { admin, token } = await createAdminWithToken();
    const merchant = await fixtures.createMerchant(admin.id);
    const { voucher } = await fixtures.createVoucherWithQrCodes(merchant.id, 5, {
      totalStock: 5,
    });

    const res = await jsonPut(`/api/admin/vouchers/${voucher.id}`, {
      title: "Renamed",
      totalStock: 1,
    }, token);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.voucher.title).toBe("Renamed");
    expect(body.voucher.totalStock).toBe(5); // unchanged
  });
});

describe("DELETE /api/admin/vouchers/:id", () => {
  test("manager can delete a voucher", async () => {
    const { admin } = await createAdminWithToken("owner");
    const merchant = await fixtures.createMerchant(admin.id);
    const { token } = await createAdminWithToken("manager");
    const { voucher } = await fixtures.createVoucherWithQrCodes(merchant.id, 0);

    const res = await authDelete(`/api/admin/vouchers/${voucher.id}`, token);
    expect(res.status).toBe(200);
  });

  test("admin assigned to the merchant can delete (even with issued/uploaded assets)", async () => {
    const merchant = await fixtures.createMerchant();
    const { token } = await createAdminWithToken("admin", merchant.id);
    const { voucher } = await fixtures.createVoucherWithQrCodes(merchant.id, 2);
    // simulate an already-issued asset — old guard would have blocked this
    await testPrisma.qrCode.updateMany({
      where: { voucherId: voucher.id },
      data: { status: "REDEEMED" },
    });

    const res = await authDelete(`/api/admin/vouchers/${voucher.id}`, token);
    expect(res.status).toBe(200);
    const after = await testPrisma.voucher.findUnique({ where: { id: voucher.id } });
    expect(after?.deletedAt).not.toBeNull();
  });

  test("owner is forbidden from deleting (manager & admin only)", async () => {
    const { admin, token } = await createAdminWithToken("owner");
    const merchant = await fixtures.createMerchant(admin.id);
    const { voucher } = await fixtures.createVoucherWithQrCodes(merchant.id, 0);

    const res = await authDelete(`/api/admin/vouchers/${voucher.id}`, token);
    expect(res.status).toBe(403);
  });

  test("admin of another merchant is forbidden", async () => {
    const ownMerchant = await fixtures.createMerchant();
    const otherMerchant = await fixtures.createMerchant();
    const { token } = await createAdminWithToken("admin", ownMerchant.id);
    const { voucher } = await fixtures.createVoucherWithQrCodes(otherMerchant.id, 0);

    const res = await authDelete(`/api/admin/vouchers/${voucher.id}`, token);
    expect(res.status).toBe(403);
  });
});
