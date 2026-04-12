import { describe, test, expect, beforeEach } from "vitest";
import { testPrisma } from "../../setup.integration.js";
import { createFixtures } from "../../helpers/fixtures.js";
import app from "@/app.js";

const fixtures = createFixtures(testPrisma);

describe("GET /api/vouchers", () => {
  beforeEach(async () => {
    const admin = await fixtures.createAdmin();
    const merchant = await fixtures.createMerchant(admin.id, { name: "M1", category: "kuliner" });
    await fixtures.createVoucherWithQrCodes(merchant.id, 5, { title: "Active Voucher" });
    await fixtures.createVoucherWithQrCodes(merchant.id, 5, { title: "Inactive Voucher", isActive: false });
    await fixtures.createVoucherWithQrCodes(merchant.id, 5, {
      title: "Expired Voucher",
      endDate: new Date("2020-01-01"),
    });
  });

  test("returns only active non-expired vouchers with stock", async () => {
    const res = await app.request("/api/vouchers");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.vouchers.length).toBe(1);
    expect(body.vouchers[0].title).toBe("Active Voucher");
  });

  test("filters by merchantId", async () => {
    const admin = await fixtures.createAdmin({ email: "admin2@test.com" });
    const m2 = await fixtures.createMerchant(admin.id, { name: "M2" });
    await fixtures.createVoucherWithQrCodes(m2.id, 3, { title: "M2 Voucher" });

    const res = await app.request(`/api/vouchers?merchantId=${m2.id}`);
    const body = await res.json();
    expect(body.vouchers.every((v: { merchantId: string }) => v.merchantId === m2.id)).toBe(true);
  });

  test("search by title", async () => {
    const res = await app.request("/api/vouchers?search=Active");
    const body = await res.json();
    expect(body.vouchers.length).toBeGreaterThan(0);
  });

  test("pagination works", async () => {
    const res = await app.request("/api/vouchers?page=1&limit=1");
    const body = await res.json();
    expect(body.pagination.page).toBe(1);
    expect(body.pagination.limit).toBe(1);
  });
});

describe("GET /api/vouchers/:id", () => {
  test("returns voucher with merchant", async () => {
    const admin = await fixtures.createAdmin();
    const merchant = await fixtures.createMerchant(admin.id);
    const { voucher } = await fixtures.createVoucherWithQrCodes(merchant.id, 3);

    const res = await app.request(`/api/vouchers/${voucher.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.voucher.id).toBe(voucher.id);
    expect(body.voucher.merchant).toBeDefined();
  });

  test("returns 404 for non-existent ID", async () => {
    const res = await app.request("/api/vouchers/550e8400-e29b-41d4-a716-446655440000");
    expect(res.status).toBe(404);
  });
});
