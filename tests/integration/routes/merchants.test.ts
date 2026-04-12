import { describe, test, expect, beforeEach } from "vitest";
import { testPrisma } from "../../setup.integration.js";
import { createFixtures } from "../../helpers/fixtures.js";
import app from "@/app.js";

const fixtures = createFixtures(testPrisma);

describe("GET /api/merchants", () => {
  beforeEach(async () => {
    const admin = await fixtures.createAdmin({ role: "admin" });
    await fixtures.createMerchant(admin.id, { name: "Active Merchant", category: "kuliner" });
    await fixtures.createMerchant(admin.id, { name: "Inactive Merchant", category: "hiburan", isActive: false });
    await fixtures.createMerchant(admin.id, { name: "Travel Merchant", category: "travel" });
  });

  test("returns paginated active merchants", async () => {
    const res = await app.request("/api/merchants");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.merchants.length).toBe(2); // Only active
    expect(body.pagination).toBeDefined();
  });

  test("filters by category", async () => {
    const res = await app.request("/api/merchants?category=kuliner");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.merchants.length).toBe(1);
    expect(body.merchants[0].category).toBe("kuliner");
  });

  test("search by name (case-insensitive)", async () => {
    const res = await app.request("/api/merchants?search=travel");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.merchants.length).toBe(1);
  });

  test("returns empty array for no matches", async () => {
    const res = await app.request("/api/merchants?search=nonexistent");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.merchants.length).toBe(0);
  });

  test("does NOT return inactive merchants", async () => {
    const res = await app.request("/api/merchants");
    const body = await res.json();
    const names = body.merchants.map((m: { name: string }) => m.name);
    expect(names).not.toContain("Inactive Merchant");
  });
});

describe("GET /api/merchants/:id", () => {
  test("returns merchant with active vouchers", async () => {
    const admin = await fixtures.createAdmin();
    const merchant = await fixtures.createMerchant(admin.id);

    const res = await app.request(`/api/merchants/${merchant.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.merchant.id).toBe(merchant.id);
  });

  test("returns 404 for non-existent ID", async () => {
    const res = await app.request("/api/merchants/550e8400-e29b-41d4-a716-446655440000");
    expect(res.status).toBe(404);
  });
});
