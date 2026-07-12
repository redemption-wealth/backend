import { describe, test, expect, beforeEach, vi } from "vitest";
import { prismaMock } from "../../mocks/prisma.js";
import { Hono } from "hono";

vi.mock("@/middleware/auth.js", () => ({
  requireManager: async (_c: any, next: any) => next(),
}));

import notificationRoutes from "@/routes/admin/notifications.js";

const app = new Hono().route("/api/admin/notifications", notificationRoutes);

const NOW = new Date("2026-07-12T00:00:00Z");

beforeEach(() => vi.clearAllMocks());

describe("GET /api/admin/notifications", () => {
  test("aggregates pending redemptions, conversions and low-stock rewards", async () => {
    prismaMock.wpRedemption.aggregate.mockResolvedValue({
      _count: { _all: 3 }, _max: { createdAt: NOW },
    } as never);
    prismaMock.wpConversion.aggregate.mockResolvedValue({
      _count: { _all: 1 }, _max: { createdAt: NOW },
    } as never);
    prismaMock.wpReward.findMany.mockResolvedValue([
      { id: "r1", title: "Voucher Kopi", stock: 0, updatedAt: NOW },
      { id: "r2", title: "Sembako", stock: 3, updatedAt: NOW },
    ] as never);

    const res = await app.request("/api/admin/notifications");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.count).toBe(4); // 1 redemption + 1 conversion + 2 rewards
    const types = json.items.map((i: { type: string }) => i.type);
    expect(types).toContain("wp_redemption_pending");
    expect(types).toContain("wp_conversion_pending");
    expect(types).toContain("reward_out_of_stock");
    expect(types).toContain("reward_low_stock");
  });

  test("returns zero count when nothing is actionable", async () => {
    prismaMock.wpRedemption.aggregate.mockResolvedValue({ _count: { _all: 0 }, _max: { createdAt: null } } as never);
    prismaMock.wpConversion.aggregate.mockResolvedValue({ _count: { _all: 0 }, _max: { createdAt: null } } as never);
    prismaMock.wpReward.findMany.mockResolvedValue([] as never);

    const res = await app.request("/api/admin/notifications");
    const json = await res.json();
    expect(json).toEqual({ count: 0, items: [] });
  });
});
