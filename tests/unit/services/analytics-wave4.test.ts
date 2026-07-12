import { describe, test, expect, beforeEach } from "vitest";
import { prismaMock } from "../../mocks/prisma.js";
import {
  getKpiTrends,
  getRedemptionSourceBreakdown,
  clearAnalyticsCache,
} from "@/services/analytics.js";

beforeEach(() => clearAnalyticsCache());

describe("getKpiTrends", () => {
  test("computes current-vs-previous deltas", async () => {
    // Promise.all order: curCount, prevCount, curConfirmed, prevConfirmed
    prismaMock.redemption.count
      .mockResolvedValueOnce(10 as never)
      .mockResolvedValueOnce(5 as never)
      .mockResolvedValueOnce(8 as never)
      .mockResolvedValueOnce(4 as never);
    // curVol, prevVol
    prismaMock.redemption.aggregate
      .mockResolvedValueOnce({ _sum: { wealthAmount: "200" } } as never)
      .mockResolvedValueOnce({ _sum: { wealthAmount: "100" } } as never);

    const result = await getKpiTrends("monthly");

    expect(result.redemptions).toEqual({ current: 10, previous: 5, deltaPct: 100 });
    expect(result.confirmedRedemptions).toEqual({ current: 8, previous: 4, deltaPct: 100 });
    expect(result.wealthVolume).toEqual({
      current: "200.0000", previous: "100.0000", deltaPct: 100,
    });
  });

  test("deltaPct is null when the previous window is empty", async () => {
    prismaMock.redemption.count
      .mockResolvedValueOnce(3 as never)
      .mockResolvedValueOnce(0 as never)
      .mockResolvedValueOnce(3 as never)
      .mockResolvedValueOnce(0 as never);
    prismaMock.redemption.aggregate
      .mockResolvedValueOnce({ _sum: { wealthAmount: null } } as never)
      .mockResolvedValueOnce({ _sum: { wealthAmount: null } } as never);

    const result = await getKpiTrends("daily");
    expect(result.redemptions.deltaPct).toBeNull();
    expect(result.wealthVolume.deltaPct).toBeNull();
  });
});

describe("getRedemptionSourceBreakdown", () => {
  test("groups confirmed redemptions by merchant category with percentages", async () => {
    prismaMock.redemption.findMany.mockResolvedValue([
      { voucher: { merchant: { category: "FnB" } } },
      { voucher: { merchant: { category: "FnB" } } },
      { voucher: { merchant: { category: "Retail" } } },
    ] as never);

    const result = await getRedemptionSourceBreakdown();
    expect(result[0]).toEqual({ categoryName: "FnB", count: 2, percentage: 67 });
    expect(result[1]).toEqual({ categoryName: "Retail", count: 1, percentage: 33 });
  });
});
