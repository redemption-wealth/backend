import { describe, test, expect, beforeEach, vi } from "vitest";
import { prismaMock } from "../../mocks/prisma.js";
import { Hono } from "hono";

// GET /api/admin/qr-codes has no per-route middleware — it reads adminAuth from
// context. Stub the auth/rate-limit modules the route imports at load time, then
// inject an owner (unscoped) adminAuth via a wrapping middleware below.
vi.mock("@/middleware/auth.js", () => ({
  requireAdminRole: async (_c: any, next: any) => next(),
  requireManagerOrAdmin: async (_c: any, next: any) => next(),
}));
vi.mock("@/middleware/rate-limit.js", () => ({
  qrScanLimiter: async (_c: any, next: any) => next(),
}));

import adminQrCodes from "@/routes/admin/qr-codes.js";

const app = new Hono();
app.use("*", async (c, next) => {
  c.set("adminAuth" as never, { adminId: "admin-1", role: "OWNER", merchantId: null } as never);
  await next();
});
app.route("/api/admin/qr-codes", adminQrCodes);

beforeEach(() => vi.clearAllMocks());

describe("GET /api/admin/qr-codes assignedToEmail", () => {
  test("populates assignedToEmail from the redemption for an assigned code and null otherwise", async () => {
    prismaMock.qrCode.findMany.mockResolvedValue([
      {
        id: "qr-assigned",
        status: "REDEEMED",
        voucher: { title: "Diskon Kopi", merchant: { name: "Kopi Kenangan" } },
        scannedBy: null,
        redemption: { userEmail: "redeemer@example.com" },
      },
      {
        id: "qr-free",
        status: "AVAILABLE",
        voucher: { title: "Diskon Kopi", merchant: { name: "Kopi Kenangan" } },
        scannedBy: null,
        redemption: null,
      },
    ] as never);
    prismaMock.qrCode.count.mockResolvedValue(2 as never);

    const res = await app.request("/api/admin/qr-codes?voucherId=v1");
    expect(res.status).toBe(200);
    const body = await res.json();

    const assigned = body.qrCodes.find((q: { id: string }) => q.id === "qr-assigned");
    const free = body.qrCodes.find((q: { id: string }) => q.id === "qr-free");

    expect(assigned.assignedToEmail).toBe("redeemer@example.com");
    expect(free.assignedToEmail).toBeNull();

    // Raw redemption relation is not leaked; existing fields are preserved.
    expect(assigned.redemption).toBeUndefined();
    expect(assigned.status).toBe("REDEEMED");
    expect(body.pagination).toMatchObject({ page: 1, limit: 50, total: 2 });
  });
});
