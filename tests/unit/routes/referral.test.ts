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
  getReferralInfo: vi.fn(),
}));

import referralRoutes from "@/routes/referral.js";
import { getOrCreateAppUser, getReferralInfo } from "@/services/appUser.js";

const app = new Hono().route("/api/referral", referralRoutes);

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getOrCreateAppUser).mockResolvedValue({ id: "u1" } as any);
});

describe("GET /api/referral", () => {
  test("returns the referral info payload", async () => {
    vi.mocked(getReferralInfo).mockResolvedValue({
      referralCode: "ABCD2345",
      stats: { friendsJoined: 2, bonusWpReceived: 62, ratePercent: 10 },
      friends: [],
    } as any);

    const res = await app.request("/api/referral", {
      headers: { authorization: "Bearer x" },
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.referralCode).toBe("ABCD2345");
    expect(json.stats.friendsJoined).toBe(2);
    expect(vi.mocked(getReferralInfo).mock.calls[0][0]).toBe("u1");
  });
});
