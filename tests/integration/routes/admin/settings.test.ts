import { describe, test, expect } from "vitest";
import { testPrisma } from "../../../setup.integration.js";
import { createFixtures } from "../../../helpers/fixtures.js";
import { jsonPut, authGet } from "../../../helpers/request.js";
import { createTestAdminToken, createTestManagerToken } from "../../../helpers/admin-session.js";

const fixtures = createFixtures(testPrisma);

// Settings routes are guarded by requireManager (MANAGER only; ADMIN → 403).
async function createAdminWithToken() {
  const admin = await fixtures.createAdmin({ role: "admin" });
  const token = await createTestAdminToken({ id: admin.id, email: admin.email });
  return { admin, token };
}

async function createManagerWithToken() {
  const manager = await fixtures.createAdmin({ role: "manager" });
  const token = await createTestManagerToken({ id: manager.id, email: manager.email });
  return { manager, token };
}

describe("GET /api/admin/settings", () => {
  test("returns settings for manager", async () => {
    const { token } = await createManagerWithToken();
    const res = await authGet("/api/admin/settings", token);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.settings).toBeDefined();
  });

  test("auto-creates singleton if missing", async () => {
    const { token } = await createManagerWithToken();
    const res = await authGet("/api/admin/settings", token);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.settings.id).toBe("singleton");
  });

  test("returns 403 for admin role", async () => {
    const { token } = await createAdminWithToken();
    const res = await authGet("/api/admin/settings", token);
    expect(res.status).toBe(403);
  });
});

describe("PUT /api/admin/settings", () => {
  test("returns 403 for admin role", async () => {
    const { token } = await createAdminWithToken();
    const res = await jsonPut("/api/admin/settings", {
      appFeeRate: 5,
    }, token);
    expect(res.status).toBe(403);
  });

  test("updates appFeeRate", async () => {
    const { token } = await createManagerWithToken();
    const res = await jsonPut("/api/admin/settings", {
      appFeeRate: 5,
    }, token);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Number(body.settings.appFeeRate)).toBe(5);
  });

  test("validates appFeeRate range", async () => {
    const { token } = await createManagerWithToken();
    const res = await jsonPut("/api/admin/settings", {
      appFeeRate: 101,
    }, token);
    expect(res.status).toBe(400);
  });
});
