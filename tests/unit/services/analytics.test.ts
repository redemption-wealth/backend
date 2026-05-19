import { describe, test, expect, beforeEach } from "vitest";
import { prismaMock } from "../../mocks/prisma.js";
import { getSummaryStats, clearAnalyticsCache } from "@/services/analytics.js";

beforeEach(() => {
  clearAnalyticsCache();
});

// UAT B8/B15 — owner/manager dashboard summary KPIs
describe("getSummaryStats", () => {
  test("positive: returns correct counts and aggregates", async () => {
    prismaMock.merchant.count.mockResolvedValue(5);
    prismaMock.voucher.count.mockResolvedValue(10);
    prismaMock.redemption.count
      .mockResolvedValueOnce(20) // totalRedemptions
      .mockResolvedValueOnce(3); // confirmedRedemptions
    // 3 aggregate calls: wealthVolume, avgWealth, totalValueIdr
    prismaMock.redemption.aggregate
      .mockResolvedValueOnce({ _sum: { wealthAmount: "123.45" } } as never)
      .mockResolvedValueOnce({ _avg: { wealthAmount: "41.15" } } as never)
      .mockResolvedValueOnce({ _sum: { priceIdrAtRedeem: 750000 } } as never);

    const result = await getSummaryStats();

    expect(result.totalMerchants).toBe(5);
    expect(result.totalVouchers).toBe(10);
    expect(result.totalRedemptions).toBe(20);
    expect(result.confirmedRedemptions).toBe(3);
    expect(result.totalWealthVolume).toBe("123.45");
    expect(result.avgWealthPerRedeem).toBe("41.15");
    expect(result.totalValueIdr).toBe(750000);
  });

  test("edge: null aggregates fall back to '0' / 0", async () => {
    prismaMock.merchant.count.mockResolvedValue(0);
    prismaMock.voucher.count.mockResolvedValue(0);
    prismaMock.redemption.count.mockResolvedValue(0);
    prismaMock.redemption.aggregate
      .mockResolvedValueOnce({ _sum: { wealthAmount: null } } as never)
      .mockResolvedValueOnce({ _avg: { wealthAmount: null } } as never)
      .mockResolvedValueOnce({ _sum: { priceIdrAtRedeem: null } } as never);

    const result = await getSummaryStats();

    expect(result.totalWealthVolume).toBe("0");
    expect(result.avgWealthPerRedeem).toBe("0");
    expect(result.totalValueIdr).toBe(0);
  });

  test("positive: merchant-scoped call returns scoped counts", async () => {
    prismaMock.merchant.count.mockResolvedValue(1);
    prismaMock.voucher.count.mockResolvedValue(4);
    prismaMock.redemption.count
      .mockResolvedValueOnce(7)
      .mockResolvedValueOnce(2);
    prismaMock.redemption.aggregate
      .mockResolvedValueOnce({ _sum: { wealthAmount: "10" } } as never)
      .mockResolvedValueOnce({ _avg: { wealthAmount: "5" } } as never)
      .mockResolvedValueOnce({ _sum: { priceIdrAtRedeem: 1000 } } as never);

    const result = await getSummaryStats("merchant-1");

    expect(result.totalMerchants).toBe(1);
    expect(result.totalVouchers).toBe(4);
    expect(result.confirmedRedemptions).toBe(2);
  });
});
