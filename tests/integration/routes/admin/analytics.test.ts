import { describe, test, expect } from "vitest";
import { testPrisma } from "../../../setup.integration.js";
import { createFixtures } from "../../../helpers/fixtures.js";
import { authGet } from "../../../helpers/request.js";
import { createTestAdminToken, createTestOwnerToken } from "../../../helpers/auth.js";

const fixtures = createFixtures(testPrisma);

async function createOwnerWithToken() {
  const owner = await fixtures.createAdmin({ role: "owner" });
  const token = await createTestOwnerToken({ id: owner.id, email: owner.email });
  return { owner, token };
}

describe("GET /api/admin/analytics/summary", () => {
  test("returns 200 for admin", async () => {
    const admin = await fixtures.createAdmin({ role: "admin" });
    const token = await createTestAdminToken({ id: admin.id, role: "admin" });
    const res = await authGet("/api/admin/analytics/summary", token);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summary).toBeDefined();
  });

  test("returns aggregated stats", async () => {
    const { owner, token } = await createOwnerWithToken();
    const merchant = await fixtures.createMerchant(owner.id);
    await fixtures.createVoucherWithQrCodes(merchant.id, 5);

    const res = await authGet("/api/admin/analytics/summary", token);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summary).toBeDefined();
    expect(body.summary.totalMerchants).toBeDefined();
    expect(body.summary.totalVouchers).toBeDefined();
  });

  test("returns zeros when no data", async () => {
    const { token } = await createOwnerWithToken();
    const res = await authGet("/api/admin/analytics/summary", token);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summary).toBeDefined();
    expect(body.summary.totalRedemptions).toBe(0);
  });
});

describe("GET /api/admin/analytics/recent-activity", () => {
  test("returns 200 for admin", async () => {
    const admin = await fixtures.createAdmin({ role: "admin" });
    const token = await createTestAdminToken({ id: admin.id, role: "admin" });
    const res = await authGet("/api/admin/analytics/recent-activity", token);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.activities).toBeDefined();
  });

  test("returns activity list", async () => {
    const { token } = await createOwnerWithToken();
    const res = await authGet("/api/admin/analytics/recent-activity?limit=5", token);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.activities).toBeDefined();
  });
});
