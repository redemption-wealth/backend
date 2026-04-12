import { describe, test, expect, vi, beforeEach } from "vitest";
import { prismaMock } from "../../mocks/prisma.js";
import { getSummary, getRecentActivity } from "@/services/analytics.js";

describe("getSummary", () => {
  test("returns correct counts", async () => {
    prismaMock.merchant.count.mockResolvedValue(5);
    prismaMock.voucher.count.mockResolvedValueOnce(10).mockResolvedValueOnce(7);
    prismaMock.redemption.count.mockResolvedValueOnce(20).mockResolvedValueOnce(3);
    prismaMock.redemption.aggregate.mockResolvedValue({
      _sum: { wealthAmount: { toString: () => "500.5" } },
      _count: {},
      _avg: {},
      _min: {},
      _max: {},
    } as never);

    const result = await getSummary();
    expect(result.totalMerchants).toBe(5);
    expect(result.totalVouchers).toBe(10);
    expect(result.activeVouchers).toBe(7);
    expect(result.totalRedemptions).toBe(20);
    expect(result.pendingRedemptions).toBe(3);
  });

  test("returns zero wealthVolume when no confirmed redemptions", async () => {
    prismaMock.merchant.count.mockResolvedValue(0);
    prismaMock.voucher.count.mockResolvedValue(0);
    prismaMock.redemption.count.mockResolvedValue(0);
    prismaMock.redemption.aggregate.mockResolvedValue({
      _sum: { wealthAmount: null },
      _count: {},
      _avg: {},
      _min: {},
      _max: {},
    } as never);

    const result = await getSummary();
    expect(result.totalWealthVolume).toBe("0");
  });
});

describe("getRecentActivity", () => {
  test("calls findMany with correct limit", async () => {
    prismaMock.redemption.findMany.mockResolvedValue([]);

    await getRecentActivity(10);
    expect(prismaMock.redemption.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 10 })
    );
  });

  test("defaults limit to 20", async () => {
    prismaMock.redemption.findMany.mockResolvedValue([]);

    await getRecentActivity();
    expect(prismaMock.redemption.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 20 })
    );
  });
});
