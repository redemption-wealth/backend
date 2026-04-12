import { describe, test, expect } from "vitest";
import { testPrisma } from "../../../setup.integration.js";
import { createFixtures } from "../../../helpers/fixtures.js";
import { authGet } from "../../../helpers/request.js";
import { createTestAdminToken } from "../../../helpers/auth.js";

const fixtures = createFixtures(testPrisma);

describe("GET /api/admin/redemptions", () => {
  test("lists all redemptions", async () => {
    const token = await createTestAdminToken();
    const res = await authGet("/api/admin/redemptions", token);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.redemptions).toBeDefined();
    expect(body.pagination).toBeDefined();
  });

  test("pagination works", async () => {
    const token = await createTestAdminToken();
    const res = await authGet("/api/admin/redemptions?page=1&limit=10", token);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pagination.page).toBe(1);
    expect(body.pagination.limit).toBe(10);
  });
});

describe("GET /api/admin/redemptions/:id", () => {
  test("returns 404 for non-existent ID", async () => {
    const token = await createTestAdminToken();
    const res = await authGet(
      "/api/admin/redemptions/550e8400-e29b-41d4-a716-446655440000",
      token
    );
    expect(res.status).toBe(404);
  });
});
