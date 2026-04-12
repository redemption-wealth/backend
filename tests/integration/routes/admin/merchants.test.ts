import { describe, test, expect } from "vitest";
import { testPrisma } from "../../../setup.integration.js";
import { createFixtures } from "../../../helpers/fixtures.js";
import { jsonPost, jsonPut, authGet, authDelete } from "../../../helpers/request.js";
import { createTestAdminToken, createTestOwnerToken } from "../../../helpers/auth.js";

const fixtures = createFixtures(testPrisma);

async function createAdminWithToken(role: "admin" | "owner" = "admin") {
  const admin = await fixtures.createAdmin({ role });
  const token = role === "owner"
    ? await createTestOwnerToken({ id: admin.id, email: admin.email })
    : await createTestAdminToken({ id: admin.id, email: admin.email });
  return { admin, token };
}

describe("GET /api/admin/merchants", () => {
  test("returns 401 without admin token", async () => {
    const res = await authGet("/api/admin/merchants", "");
    expect(res.status).toBe(401);
  });

  test("returns all merchants including inactive", async () => {
    const { admin, token } = await createAdminWithToken();
    await fixtures.createMerchant(admin.id, { isActive: true });
    await fixtures.createMerchant(admin.id, { isActive: false });

    const res = await authGet("/api/admin/merchants", token);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.merchants.length).toBe(2);
  });
});

describe("POST /api/admin/merchants", () => {
  test("creates merchant with valid data", async () => {
    const { token } = await createAdminWithToken();

    // Create category first
    const category = await testPrisma.category.upsert({
      where: { name: "kuliner" },
      update: {},
      create: { name: "kuliner", isActive: true },
    });

    const res = await jsonPost("/api/admin/merchants", {
      name: "New Merchant",
      categoryId: category.id,
    }, token);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.merchant.name).toBe("New Merchant");
  });

  test("returns 400 for invalid data", async () => {
    const { token } = await createAdminWithToken();

    const category = await testPrisma.category.upsert({
      where: { name: "kuliner" },
      update: {},
      create: { name: "kuliner", isActive: true },
    });

    const res = await jsonPost("/api/admin/merchants", {
      name: "A", // too short
      categoryId: category.id,
    }, token);
    expect(res.status).toBe(400);
  });

  test("returns 400 for invalid category", async () => {
    const { token } = await createAdminWithToken();
    const res = await jsonPost("/api/admin/merchants", {
      name: "Valid Name",
      category: "invalid",
    }, token);
    expect(res.status).toBe(400);
  });
});

describe("PUT /api/admin/merchants/:id", () => {
  test("updates merchant fields", async () => {
    const { admin, token } = await createAdminWithToken();
    const merchant = await fixtures.createMerchant(admin.id);

    const res = await jsonPut(`/api/admin/merchants/${merchant.id}`, {
      name: "Updated Name",
    }, token);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.merchant.name).toBe("Updated Name");
  });

  test("returns 404 for non-existent merchant", async () => {
    const { token } = await createAdminWithToken();
    const res = await jsonPut("/api/admin/merchants/550e8400-e29b-41d4-a716-446655440000", {
      name: "Updated",
    }, token);
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/admin/merchants/:id", () => {
  test("returns 403 for non-owner admin", async () => {
    const { admin, token } = await createAdminWithToken("admin");
    const merchant = await fixtures.createMerchant(admin.id);

    const res = await authDelete(`/api/admin/merchants/${merchant.id}`, token);
    expect(res.status).toBe(403);
  });

  test("deletes merchant for owner", async () => {
    const { admin, token } = await createAdminWithToken("owner");
    const merchant = await fixtures.createMerchant(admin.id);

    const res = await authDelete(`/api/admin/merchants/${merchant.id}`, token);
    expect(res.status).toBe(200);
  });
});
