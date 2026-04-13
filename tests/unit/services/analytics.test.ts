import { describe, test, expect, beforeEach } from "vitest";
import { prismaMock } from "../../mocks/prisma.js";
import { getSummaryStats, clearAnalyticsCache } from "@/services/analytics.js";

beforeEach(() => {
  clearAnalyticsCache();
});

describe("getSummaryStats", () => {
  test("returns correct counts", async () => {
    prismaMock.merchant.count.mockResolvedValue(5);
    prismaMock.voucher.count.mockResolvedValue(10);
    prismaMock.redemption.count
      .mockResolvedValueOnce(20) // totalRedemptions
      .mockResolvedValueOnce(3); // confirmedRedemptions
    prismaMock.user.count.mockResolvedValue(50);
    prismaMock.redemption.aggregate.mockResolvedValue({
      _sum: { wealthAmount: null, priceIdrAtRedeem: null },
      _avg: { wealthAmount: null },
      _count: {},
      _min: {},
      _max: {},
    } as never);

    const result = await getSummaryStats();
    expect(result.totalMerchants).toBe(5);
    expect(result.totalVouchers).toBe(10);
    expect(result.totalRedemptions).toBe(20);
    expect(result.confirmedRedemptions).toBe(3);
    expect(result.totalUsers).toBe(50);
  });

  test("returns zero wealthVolume when no confirmed redemptions", async () => {
    prismaMock.merchant.count.mockResolvedValue(0);
    prismaMock.voucher.count.mockResolvedValue(0);
    prismaMock.redemption.count.mockResolvedValue(0);
    prismaMock.user.count.mockResolvedValue(0);
    prismaMock.redemption.aggregate.mockResolvedValue({
      _sum: { wealthAmount: null, priceIdrAtRedeem: null },
      _avg: { wealthAmount: null },
      _count: {},
      _min: {},
      _max: {},
    } as never);

    const result = await getSummaryStats();
    expect(result.totalWealthVolume).toBe("0");
  });
});
