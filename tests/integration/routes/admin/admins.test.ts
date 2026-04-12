import { describe, test, expect } from "vitest";
import { testPrisma } from "../../../setup.integration.js";
import { createFixtures } from "../../../helpers/fixtures.js";
import { jsonPost, jsonPut, authGet, authDelete } from "../../../helpers/request.js";
import { createTestAdminToken, createTestOwnerToken } from "../../../helpers/auth.js";

const fixtures = createFixtures(testPrisma);

async function createOwnerWithToken() {
  const owner = await fixtures.createAdmin({ role: "owner" });
  const token = await createTestOwnerToken({ id: owner.id, email: owner.email });
  return { owner, token };
}

describe("GET /api/admin/admins", () => {
  test("returns 403 for non-owner admin", async () => {
    const admin = await fixtures.createAdmin({ role: "admin" });
    const token = await createTestAdminToken({ id: admin.id, role: "admin" });
    const res = await authGet("/api/admin/admins", token);
    expect(res.status).toBe(403);
  });

  test("lists all admins for owner", async () => {
    await fixtures.createAdmin({ email: "a1@test.com" });
    await fixtures.createAdmin({ email: "a2@test.com" });

    const { token } = await createOwnerWithToken();
    const res = await authGet("/api/admin/admins", token);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.admins.length).toBeGreaterThanOrEqual(2);
    expect(body.admins[0].passwordHash).toBeUndefined();
  });
});

describe("POST /api/admin/admins", () => {
  test("creates admin with null passwordHash", async () => {
    const { token } = await createOwnerWithToken();
    const res = await jsonPost("/api/admin/admins", {
      email: `newadmin-${Date.now()}@test.com`,
    }, token);
    expect(res.status).toBe(201);
  });

  test("creates admin with password", async () => {
    const { token } = await createOwnerWithToken();
    const res = await jsonPost("/api/admin/admins", {
      email: `withpass-${Date.now()}@test.com`,
      password: "password-123",
    }, token);
    expect(res.status).toBe(201);
  });

  test("returns 400 for duplicate email", async () => {
    const existing = await fixtures.createAdmin({ email: "dup@test.com" });
    const { token } = await createOwnerWithToken();
    const res = await jsonPost("/api/admin/admins", {
      email: "dup@test.com",
    }, token);
    expect(res.status).toBe(400);
  });

  test("returns 400 for invalid data", async () => {
    const { token } = await createOwnerWithToken();
    const res = await jsonPost("/api/admin/admins", {
      email: "not-an-email",
    }, token);
    expect(res.status).toBe(400);
  });

  test("returns 403 for non-owner", async () => {
    const admin = await fixtures.createAdmin({ role: "admin" });
    const token = await createTestAdminToken({ id: admin.id, role: "admin" });
    const res = await jsonPost("/api/admin/admins", {
      email: "test@test.com",
    }, token);
    expect(res.status).toBe(403);
  });
});

describe("PUT /api/admin/admins/:id", () => {
  test("toggles isActive", async () => {
    const admin = await fixtures.createAdmin({ isActive: true });
    const { token } = await createOwnerWithToken();

    const res = await jsonPut(`/api/admin/admins/${admin.id}`, {
      isActive: false,
    }, token);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.admin.isActive).toBe(false);
  });
});

describe("DELETE /api/admin/admins/:id", () => {
  test("deletes admin", async () => {
    const admin = await fixtures.createAdmin({ role: "admin" });
    const { token } = await createOwnerWithToken();

    const res = await authDelete(`/api/admin/admins/${admin.id}`, token);
    expect(res.status).toBe(200);
  });

  test("returns 400 when deleting self", async () => {
    const { owner, token } = await createOwnerWithToken();
    const res = await authDelete(`/api/admin/admins/${owner.id}`, token);
    expect(res.status).toBe(400);
  });
});
