import { describe, test, expect, vi, beforeEach } from "vitest";

vi.mock("@/db.js", () => ({
  prisma: {
    appUser: { findUnique: vi.fn(), findMany: vi.fn() },
    wpLedger: { findMany: vi.fn() },
  },
}));

import { prisma } from "@/db.js";
import { getReferralInfo } from "@/services/appUser.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any;

beforeEach(() => vi.resetAllMocks());

describe("getReferralInfo", () => {
  test("returns code, stats, and masked friends with per-friend bonus", async () => {
    db.appUser.findUnique.mockResolvedValue({ referralCode: "ABCD2345" });
    db.appUser.findMany.mockResolvedValue([
      { id: "f1", email: "andini@gmail.com", hasDeposited: true, createdAt: new Date("2026-07-01") },
      { id: "f2", email: "bo@x.co", hasDeposited: false, createdAt: new Date("2026-07-02") },
    ]);
    db.wpLedger.findMany.mockResolvedValue([{ refId: "f1", amount: 62 }]);

    const info = await getReferralInfo("u1");

    expect(info.referralCode).toBe("ABCD2345");
    expect(info.stats).toEqual({
      friendsJoined: 2,
      bonusWpReceived: 62,
      ratePercent: 10,
    });
    // emails are masked
    expect(info.friends[0]).toMatchObject({
      label: "and***@gmail.com",
      qualified: true,
      bonusWp: 62,
    });
    expect(info.friends[1]).toMatchObject({
      label: "bo***@x.co",
      qualified: false,
      bonusWp: 0, // no bonus yet (not qualified)
    });
  });

  test("handles a user with no referrals", async () => {
    db.appUser.findUnique.mockResolvedValue({ referralCode: "ZZZZ9999" });
    db.appUser.findMany.mockResolvedValue([]);
    db.wpLedger.findMany.mockResolvedValue([]);

    const info = await getReferralInfo("u1");
    expect(info.stats.friendsJoined).toBe(0);
    expect(info.friends).toEqual([]);
  });
});
