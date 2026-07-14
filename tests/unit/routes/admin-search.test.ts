import { describe, test, expect, beforeEach, vi } from "vitest";
import { prismaMock } from "../../mocks/prisma.js";
import { Hono } from "hono";

vi.mock("@/middleware/auth.js", () => ({
  requireManager: async (_c: any, next: any) => next(),
}));

import searchRoutes from "@/routes/admin/search.js";

const app = new Hono().route("/api/admin/search", searchRoutes);

beforeEach(() => vi.clearAllMocks());

describe("GET /api/admin/search", () => {
  test("empty q returns empty buckets without querying", async () => {
    const res = await app.request("/api/admin/search?q=");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ merchants: [], vouchers: [], users: [] });
    expect(prismaMock.merchant.findMany).not.toHaveBeenCalled();
  });

  test("maps merchants, vouchers and users", async () => {
    prismaMock.merchant.findMany.mockResolvedValue([
      { id: "m1", name: "Kopi Kenangan", logoUrl: null, category: "FnB", isActive: true },
    ] as never);
    prismaMock.voucher.findMany.mockResolvedValue([
      { id: "v1", title: "Diskon Kopi", isActive: true, merchant: { id: "m1", name: "Kopi Kenangan" } },
    ] as never);
    prismaMock.appUser.findMany.mockResolvedValue([
      { id: "u1", email: "kopi@x.com", name: "Kopi", username: "kopilover" },
    ] as never);

    const res = await app.request("/api/admin/search?q=kopi");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.merchants[0]).toEqual({
      id: "m1", name: "Kopi Kenangan", logoUrl: null, category: "FnB", isActive: true,
    });
    expect(json.vouchers[0]).toEqual({
      id: "v1", title: "Diskon Kopi", isActive: true, merchantId: "m1", merchantName: "Kopi Kenangan",
    });
    expect(json.users[0]).toEqual({
      id: "u1", email: "kopi@x.com", name: "Kopi", username: "kopilover",
    });
  });
});
