import { describe, test, expect } from "vitest";
import app from "@/app.js";

describe("Health Check", () => {
  test("GET /api/health returns status ok", async () => {
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.timestamp).toBeDefined();
  });

  test("GET /api/health returns valid ISO timestamp", async () => {
    const res = await app.request("/api/health");
    const body = await res.json();
    const date = new Date(body.timestamp);
    expect(date.getTime()).not.toBeNaN();
  });
});
