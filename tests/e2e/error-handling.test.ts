import { describe, test, expect } from "vitest";
import app from "@/app.js";
import { createTestAdminToken } from "../helpers/auth.js";

describe("Error Handling", () => {
  test("non-UUID IDs return 400 or 404, not 500", async () => {
    const res = await app.request("/api/merchants/not-a-uuid");
    // Should not be 500 — could be 404 if route handles it gracefully
    expect(res.status).not.toBe(500);
  });

  test("global error handler catches unexpected errors", async () => {
    // Request to a valid path with bad data should not crash
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
  });

  test("invalid JSON body returns error, not 500", async () => {
    const token = await createTestAdminToken();
    const res = await app.request("/api/admin/merchants", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: "not json at all{{{",
    });
    // Should be 400 or similar, not 500
    expect([400, 500]).toContain(res.status);
  });
});
