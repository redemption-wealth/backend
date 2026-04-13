import { describe, test, expect } from "vitest";
import { testPrisma } from "../../../setup.integration.js";
import { createFixtures } from "../../../helpers/fixtures.js";
import { jsonPut, authGet } from "../../../helpers/request.js";
import { createTestAdminToken, createTestOwnerToken } from "../../../helpers/auth.js";

const fixtures = createFixtures(testPrisma);

async function createAdminWithToken() {
  const admin = await fixtures.createAdmin();
  const token = await createTestAdminToken({ id: admin.id, email: admin.email });
  return { admin, token };
}

async function createOwnerWithToken() {
  const owner = await fixtures.createAdmin({ role: "owner" });
  const token = await createTestOwnerToken({ id: owner.id, email: owner.email });
  return { owner, token };
}

describe("GET /api/admin/settings", () => {
  test("returns settings for owner", async () => {
    const { token } = await createOwnerWithToken();
    const res = await authGet("/api/admin/settings", token);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.settings).toBeDefined();
  });

  test("auto-creates singleton if missing", async () => {
    const { token } = await createOwnerWithToken();
    const res = await authGet("/api/admin/settings", token);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.settings.id).toBe("singleton");
  });

  test("returns 403 for non-owner admin", async () => {
    const { token } = await createAdminWithToken();
    const res = await authGet("/api/admin/settings", token);
    expect(res.status).toBe(403);
  });
});

describe("PUT /api/admin/settings", () => {
  test("returns 403 for non-owner", async () => {
    const { token } = await createAdminWithToken();
    const res = await jsonPut("/api/admin/settings", {
      appFeePercentage: 5,
    }, token);
    expect(res.status).toBe(403);
  });

  test("updates appFeePercentage", async () => {
    const { token } = await createOwnerWithToken();
    const res = await jsonPut("/api/admin/settings", {
      appFeePercentage: 5,
    }, token);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Number(body.settings.appFeePercentage)).toBe(5);
  });

  test("validates appFeePercentage range", async () => {
    const { token } = await createOwnerWithToken();
    const res = await jsonPut("/api/admin/settings", {
      appFeePercentage: 101,
    }, token);
    expect(res.status).toBe(400);
  });
});
