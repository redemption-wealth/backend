import { describe, test, expect, vi, beforeEach } from "vitest";

vi.mock("@/db.js", () => ({
  prisma: {
    appUser: { findUnique: vi.fn(), findMany: vi.fn() },
    wpLedger: { findMany: vi.fn() },
    appSettings: { findUnique: vi.fn() },
  },
}));

import { prisma } from "@/db.js";
import { getReferralInfo } from "@/services/appUser.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any;

beforeEach(() => vi.resetAllMocks());

describe("getReferralInfo", () => {
  test("returns code, flat-bonus stats, code-entry state, and masked friends", async () => {
    db.appUser.findUnique.mockResolvedValue({
      referralCode: "ABCD2345",
      referredById: null,
      hasDeposited: false,
    });
    db.appSettings.findUnique.mockResolvedValue({
      wpReferrerBonusWp: 50,
      wpRefereeWelcomeWp: 50,
    });
    db.appUser.findMany.mockResolvedValue([
      { id: "f1", email: "andini@gmail.com", hasDeposited: true, createdAt: new Date("2026-07-01") },
      { id: "f2", email: "bo@x.co", hasDeposited: false, createdAt: new Date("2026-07-02") },
    ]);
    db.wpLedger.findMany.mockResolvedValue([{ refId: "f1", amount: 50 }]);

    const info = await getReferralInfo("u1");

    expect(info.referralCode).toBe("ABCD2345");
    // No referrer set and not yet qualified → can still enter a friend's code.
    expect(info.hasReferrer).toBe(false);
    expect(info.canApplyCode).toBe(true);
    expect(info.stats).toEqual({
      friendsJoined: 2,
      bonusWpReceived: 50,
      referrerBonusWp: 50,
      refereeWelcomeWp: 50,
    });
    // emails are masked
    expect(info.friends[0]).toMatchObject({
      label: "and***@gmail.com",
      qualified: true,
      bonusWp: 50,
    });
    expect(info.friends[1]).toMatchObject({
      label: "bo***@x.co",
      qualified: false,
      bonusWp: 0, // no bonus yet (not qualified)
    });
  });

  test("canApplyCode is false once a referrer is set or the user has deposited", async () => {
    db.appUser.findUnique.mockResolvedValue({
      referralCode: "ZZZZ9999",
      referredById: "someone",
      hasDeposited: true,
    });
    db.appSettings.findUnique.mockResolvedValue(null); // falls back to defaults
    db.appUser.findMany.mockResolvedValue([]);
    db.wpLedger.findMany.mockResolvedValue([]);

    const info = await getReferralInfo("u1");
    expect(info.stats.friendsJoined).toBe(0);
    expect(info.stats.referrerBonusWp).toBe(50); // default fallback
    expect(info.hasReferrer).toBe(true);
    expect(info.canApplyCode).toBe(false);
    expect(info.friends).toEqual([]);
  });
});
