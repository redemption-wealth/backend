import { describe, test, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

vi.mock("@/middleware/auth.js", () => ({
  requireUser: async (c: any, next: any) => {
    c.set("userAuth", {
      type: "user",
      userEmail: "a@x.com",
      privyUserId: "privy_1",
    });
    return next();
  },
}));

vi.mock("@/services/appUser.js", () => ({
  getOrCreateAppUser: vi.fn(),
}));

// Keep the real error classes, mock the functions.
vi.mock("@/services/reward.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/reward.js")>();
  return { ...actual, listRewards: vi.fn(), redeemReward: vi.fn() };
});

import rewardRoutes from "@/routes/rewards.js";
import { getOrCreateAppUser } from "@/services/appUser.js";
import {
  listRewards,
  redeemReward,
  NotQualifiedError,
} from "@/services/reward.js";

const app = new Hono().route("/api/rewards", rewardRoutes);

function redeem(id: string) {
  return app.request(`/api/rewards/${id}/redeem`, {
    method: "POST",
    headers: { authorization: "Bearer x" },
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getOrCreateAppUser).mockResolvedValue({ id: "u1" } as any);
});

describe("GET /api/rewards", () => {
  test("returns the catalog", async () => {
    vi.mocked(listRewards).mockResolvedValue([
      { id: "r1", title: "Voucher Kopi", wpCost: 300 },
    ] as any);

    const res = await app.request("/api/rewards", {
      headers: { authorization: "Bearer x" },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.rewards).toHaveLength(1);
  });
});

describe("POST /api/rewards/:id/redeem", () => {
  test("403 when the user has not deposited (anti-bot gate)", async () => {
    vi.mocked(redeemReward).mockRejectedValue(new NotQualifiedError());
    const res = await redeem("r1");
    expect(res.status).toBe(403);
  });

  test("201 with the pending redemption on success", async () => {
    vi.mocked(redeemReward).mockResolvedValue({
      id: "wr1",
      status: "PENDING",
      wpSpent: 300,
    } as any);
    const res = await redeem("r1");
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.redemption.status).toBe("PENDING");
  });
});
