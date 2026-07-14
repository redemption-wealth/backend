import { describe, test, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

vi.mock("@/middleware/auth.js", () => ({
  requireManager: async (_c: any, next: any) => next(),
}));

vi.mock("@/services/wpAdmin.js", () => ({
  getFraudReport: vi.fn(),
  setFraudReviewStatus: vi.fn(),
}));

import wpFraudRoutes from "@/routes/admin/wp-fraud.js";
import { getFraudReport, setFraudReviewStatus } from "@/services/wpAdmin.js";

const app = new Hono().route("/api/admin/wp-fraud", wpFraudRoutes);

beforeEach(() => vi.resetAllMocks());

describe("GET /api/admin/wp-fraud", () => {
  test("returns the enriched report", async () => {
    vi.mocked(getFraudReport).mockResolvedValue({
      topEarners: [],
      fastEarners: [],
      summary: { topEarnerWp: 0, fastest24hWp: 0, reviewingCount: 0, flaggedCount: 0, clearedCount: 0 },
    } as never);
    const res = await app.request("/api/admin/wp-fraud");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.summary).toBeDefined();
  });
});

describe("PATCH /api/admin/wp-fraud/:appUserId/review", () => {
  function patch(id: string, body: unknown) {
    return app.request(`/api/admin/wp-fraud/${id}/review`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  test("sets the review status", async () => {
    vi.mocked(setFraudReviewStatus).mockResolvedValue({
      appUserId: "u1",
      fraudReviewStatus: "FLAGGED",
    } as never);
    const res = await patch("u1", { status: "FLAGGED" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ appUserId: "u1", fraudReviewStatus: "FLAGGED" });
    expect(setFraudReviewStatus).toHaveBeenCalledWith("u1", "FLAGGED");
  });

  test("400 on invalid status", async () => {
    const res = await patch("u1", { status: "BOGUS" });
    expect(res.status).toBe(400);
    expect(setFraudReviewStatus).not.toHaveBeenCalled();
  });

  test("404 when the user does not exist", async () => {
    vi.mocked(setFraudReviewStatus).mockResolvedValue(null as never);
    const res = await patch("nope", { status: "CLEARED" });
    expect(res.status).toBe(404);
  });
});
