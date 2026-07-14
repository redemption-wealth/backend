import { describe, test, expect, beforeEach } from "vitest";
import { prismaMock } from "../../mocks/prisma.js";
import {
  listAppUsers,
  getAppUserDetail,
  getFraudReport,
  setFraudReviewStatus,
} from "@/services/wpAdmin.js";

const NOW = new Date("2026-07-12T00:00:00Z");

beforeEach(() => {
  // Default: no counts unless a test overrides.
  prismaMock.appUser.count.mockResolvedValue(0 as never);
});

describe("listAppUsers enrichment", () => {
  test("adds totalEarnedWp, lastActiveAt and derived tier per user", async () => {
    prismaMock.appUser.findMany.mockResolvedValue([
      { id: "u1", email: "a@x.com", walletAddress: null, referralCode: "R1", hasDeposited: true, createdAt: NOW, _count: { referrals: 2 } },
      { id: "u2", email: "b@x.com", walletAddress: null, referralCode: "R2", hasDeposited: false, createdAt: NOW, _count: { referrals: 0 } },
    ] as never);
    prismaMock.appUser.count.mockResolvedValue(2 as never);

    // Promise.all order: balances, earned, lastActive
    prismaMock.wpLedger.groupBy
      .mockResolvedValueOnce([
        { appUserId: "u1", _sum: { amount: 40_000 } },
        { appUserId: "u2", _sum: { amount: 500 } },
      ] as never)
      .mockResolvedValueOnce([
        { appUserId: "u1", _sum: { amount: 120_000 } }, // → Gold
        { appUserId: "u2", _sum: { amount: 500 } }, // → Bronze
      ] as never)
      .mockResolvedValueOnce([
        { appUserId: "u1", _max: { createdAt: NOW } },
      ] as never);

    const result = await listAppUsers({});

    expect(result.total).toBe(2);
    const u1 = result.items.find((u) => u.id === "u1")!;
    expect(u1.balance).toBe(40_000);
    expect(u1.totalEarnedWp).toBe(120_000);
    expect(u1.tier).toBe("Gold");
    expect(u1.lastActiveAt).toEqual(NOW);

    const u2 = result.items.find((u) => u.id === "u2")!;
    expect(u2.totalEarnedWp).toBe(500);
    expect(u2.tier).toBe("Bronze");
    expect(u2.lastActiveAt).toBeNull(); // no lastActive row
  });
});

describe("getAppUserDetail enrichment", () => {
  test("returns tier + totalEarnedWp + lastActiveAt + fraudReviewStatus", async () => {
    prismaMock.appUser.findUnique.mockResolvedValue({
      id: "u1", email: "a@x.com", walletAddress: null, referralCode: "R1",
      referredById: null, hasDeposited: true, qualifiedAt: null,
      fraudReviewStatus: "REVIEWING", createdAt: NOW, _count: { referrals: 1 },
    } as never);
    // Promise.all order: balAgg, earnedAgg, lastActiveAgg, ledger
    prismaMock.wpLedger.aggregate
      .mockResolvedValueOnce({ _sum: { amount: 30_000 } } as never)
      .mockResolvedValueOnce({ _sum: { amount: 30_000 } } as never)
      .mockResolvedValueOnce({ _max: { createdAt: NOW } } as never);
    prismaMock.wpLedger.findMany.mockResolvedValue([] as never);

    const detail = await getAppUserDetail("u1");

    expect(detail).not.toBeNull();
    expect(detail!.balance).toBe(30_000);
    expect(detail!.totalEarnedWp).toBe(30_000);
    expect(detail!.tier).toBe("Silver");
    expect(detail!.lastActiveAt).toEqual(NOW);
    expect(detail!.fraudReviewStatus).toBe("REVIEWING");
  });

  test("returns null for a missing user", async () => {
    prismaMock.appUser.findUnique.mockResolvedValue(null as never);
    expect(await getAppUserDetail("nope")).toBeNull();
  });
});

describe("getFraudReport", () => {
  test("annotates rows with reason, wpIn24h, lastActiveAt and summary", async () => {
    // topEarners groupBy → then joinEmails findMany
    prismaMock.wpLedger.groupBy
      .mockResolvedValueOnce([{ appUserId: "u1", _sum: { amount: 200_000 } }] as never) // top
      .mockResolvedValueOnce([{ appUserId: "u2", _sum: { amount: 5_000 } }] as never) // fast
      // getFraudReport inner: wp24h, lastActive
      .mockResolvedValueOnce([
        { appUserId: "u1", _sum: { amount: 150_000 } }, // high ratio 150k/200k = .75
        { appUserId: "u2", _sum: { amount: 1_000 } }, // 1k/5k = .2 → not high ratio
      ] as never)
      .mockResolvedValueOnce([
        { appUserId: "u1", _max: { createdAt: NOW } },
        { appUserId: "u2", _max: { createdAt: NOW } },
      ] as never);

    // joinEmails findMany (called for top then fast)
    prismaMock.appUser.findMany
      .mockResolvedValueOnce([
        { id: "u1", email: "a@x.com", hasDeposited: true, fraudReviewStatus: "NONE" },
      ] as never)
      .mockResolvedValueOnce([
        { id: "u2", email: "b@x.com", hasDeposited: false, fraudReviewStatus: "FLAGGED" },
      ] as never);

    prismaMock.appUser.count
      .mockResolvedValueOnce(1 as never) // REVIEWING
      .mockResolvedValueOnce(3 as never) // FLAGGED
      .mockResolvedValueOnce(2 as never); // CLEARED

    const report = await getFraudReport(10);

    const top = report.topEarners[0];
    expect(top.appUserId).toBe("u1");
    expect(top.wpIn24h).toBe(150_000);
    expect(top.reason).toBe("Rasio earn tinggi"); // ratio ≥ 0.6
    expect(top.fraudReviewStatus).toBe("NONE");

    const fast = report.fastEarners[0];
    expect(fast.reason).toBe("Earn cepat 24 jam");
    expect(fast.fraudReviewStatus).toBe("FLAGGED");

    expect(report.summary.topEarnerWp).toBe(200_000);
    expect(report.summary.fastest24hWp).toBe(1_000);
    expect(report.summary.reviewingCount).toBe(1);
    expect(report.summary.flaggedCount).toBe(3);
    expect(report.summary.clearedCount).toBe(2);
  });
});

describe("setFraudReviewStatus", () => {
  test("updates and returns the new status", async () => {
    prismaMock.appUser.findUnique.mockResolvedValue({ id: "u1" } as never);
    prismaMock.appUser.update.mockResolvedValue({ id: "u1", fraudReviewStatus: "FLAGGED" } as never);

    const res = await setFraudReviewStatus("u1", "FLAGGED");
    expect(res).toEqual({ appUserId: "u1", fraudReviewStatus: "FLAGGED" });
  });

  test("returns null when the user does not exist", async () => {
    prismaMock.appUser.findUnique.mockResolvedValue(null as never);
    const res = await setFraudReviewStatus("nope", "CLEARED");
    expect(res).toBeNull();
  });
});
