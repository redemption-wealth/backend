import { describe, test, expect } from "vitest";
import { testPrisma } from "../../../setup.integration.js";
import { createFixtures } from "../../../helpers/fixtures.js";
import { jsonPost, jsonPut, authDelete } from "../../../helpers/request.js";
import { createTestAdminToken, createTestOwnerToken } from "../../../helpers/auth.js";

const fixtures = createFixtures(testPrisma);

async function createAdminWithToken(role: "admin" | "owner" = "admin") {
  const admin = await fixtures.createAdmin({ role });
  const token = role === "owner"
    ? await createTestOwnerToken({ id: admin.id, email: admin.email })
    : await createTestAdminToken({ id: admin.id, email: admin.email });
  return { admin, token };
}

describe("POST /api/admin/vouchers", () => {
  test("creates voucher with valid data", async () => {
    const { admin, token } = await createAdminWithToken();
    const merchant = await fixtures.createMerchant(admin.id);

    const res = await jsonPost("/api/admin/vouchers", {
      merchantId: merchant.id,
      title: "Test Voucher",
      startDate: "2026-01-01",
      endDate: "2026-12-31",
      totalStock: 10,
      priceIdr: 25000,
    }, token);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.voucher.remainingStock).toBe(10);
    expect(body.voucher.qrPerRedemption).toBe(1);
  });

  test("returns 400 for endDate < startDate", async () => {
    const { admin, token } = await createAdminWithToken();
    const merchant = await fixtures.createMerchant(admin.id);

    const res = await jsonPost("/api/admin/vouchers", {
      merchantId: merchant.id,
      title: "Bad Dates",
      startDate: "2026-12-31",
      endDate: "2026-01-01",
      totalStock: 10,
      priceIdr: 25000,
    }, token);
    expect(res.status).toBe(400);
  });

  test("returns 400 for negative totalStock", async () => {
    const { admin, token } = await createAdminWithToken();
    const merchant = await fixtures.createMerchant(admin.id);

    const res = await jsonPost("/api/admin/vouchers", {
      merchantId: merchant.id,
      title: "Bad Stock",
      startDate: "2026-01-01",
      endDate: "2026-12-31",
      totalStock: -1,
      priceIdr: 25000,
    }, token);
    expect(res.status).toBe(400);
  });

  test("accepts qrPerRedemption = 2", async () => {
    const { admin, token } = await createAdminWithToken();
    const merchant = await fixtures.createMerchant(admin.id);

    const res = await jsonPost("/api/admin/vouchers", {
      merchantId: merchant.id,
      title: "Multi-QR",
      startDate: "2026-01-01",
      endDate: "2026-12-31",
      totalStock: 10,
      priceIdr: 50000,
      qrPerRedemption: 2,
    }, token);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.voucher.qrPerRedemption).toBe(2);
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
});

describe("DELETE /api/admin/vouchers/:id", () => {
  test("owner can delete voucher without redemptions", async () => {
    const { admin, token } = await createAdminWithToken("owner");
    const merchant = await fixtures.createMerchant(admin.id);
    const { voucher } = await fixtures.createVoucherWithQrCodes(merchant.id, 0);

    const res = await authDelete(`/api/admin/vouchers/${voucher.id}`, token);
    expect(res.status).toBe(200);
  });

  test("returns 403 for non-owner", async () => {
    const { admin, token } = await createAdminWithToken("admin");
    const merchant = await fixtures.createMerchant(admin.id);
    const { voucher } = await fixtures.createVoucherWithQrCodes(merchant.id, 0);

    const res = await authDelete(`/api/admin/vouchers/${voucher.id}`, token);
    expect(res.status).toBe(403);
  });
});
