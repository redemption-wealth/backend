import { describe, test, expect, beforeEach } from "vitest";
import { prismaMock } from "../../mocks/prisma.js";
import {
  getKpiTrends,
  getRedemptionSourceBreakdown,
  getTopMerchants,
  getTopVouchers,
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

    const result = await getRedemptionSourceBreakdown("monthly");
    expect(result[0]).toEqual({ categoryName: "FnB", count: 2, percentage: 67 });
    expect(result[1]).toEqual({ categoryName: "Retail", count: 1, percentage: 33 });
  });

  test("window-filters confirmed redemptions by createdAt >= startDate", async () => {
    prismaMock.redemption.findMany.mockResolvedValue([] as never);

    await getRedemptionSourceBreakdown("daily");

    const where = prismaMock.redemption.findMany.mock.calls[0][0]?.where as {
      status: string;
      createdAt: { gte: Date };
    };
    expect(where.status).toBe("CONFIRMED");
    expect(where.createdAt.gte).toBeInstanceOf(Date);
  });
});

describe("getTopMerchants", () => {
  test("ranks merchants by redemptions within the window", async () => {
    prismaMock.redemption.findMany.mockResolvedValue([
      { wealthAmount: "10", voucher: { merchant: { id: "m1", name: "Alpha", logoUrl: null } } },
      { wealthAmount: "20", voucher: { merchant: { id: "m1", name: "Alpha", logoUrl: null } } },
      { wealthAmount: "5", voucher: { merchant: { id: "m2", name: "Beta", logoUrl: null } } },
    ] as never);

    const result = await getTopMerchants("monthly", 3);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      merchantId: "m1",
      merchantName: "Alpha",
      logoUrl: null,
      redemptionCount: 2,
      wealthVolume: "30.0000",
    });
    expect(result[1].merchantId).toBe("m2");
  });

  test("query is window-scoped to CONFIRMED + createdAt >= startDate", async () => {
    prismaMock.redemption.findMany.mockResolvedValue([] as never);

    await getTopMerchants("daily", 3);

    const where = prismaMock.redemption.findMany.mock.calls[0][0]?.where as {
      status: string;
      createdAt: { gte: Date };
    };
    expect(where.status).toBe("CONFIRMED");
    expect(where.createdAt.gte).toBeInstanceOf(Date);
  });

  test("merchant-scoped call adds voucher.merchantId filter", async () => {
    prismaMock.redemption.findMany.mockResolvedValue([] as never);

    await getTopMerchants("monthly", 3, "merchant-1");

    const where = prismaMock.redemption.findMany.mock.calls[0][0]?.where as {
      voucher: { merchantId: string };
    };
    expect(where.voucher.merchantId).toBe("merchant-1");
  });

  test("different periods cache separately", async () => {
    prismaMock.redemption.findMany
      .mockResolvedValueOnce([
        { wealthAmount: "10", voucher: { merchant: { id: "m1", name: "Alpha", logoUrl: null } } },
      ] as never)
      .mockResolvedValueOnce([
        { wealthAmount: "5", voucher: { merchant: { id: "m2", name: "Beta", logoUrl: null } } },
        { wealthAmount: "5", voucher: { merchant: { id: "m2", name: "Beta", logoUrl: null } } },
      ] as never);

    const daily = await getTopMerchants("daily", 3);
    const monthly = await getTopMerchants("monthly", 3);

    expect(daily[0].merchantId).toBe("m1");
    expect(monthly[0].merchantId).toBe("m2");
    expect(prismaMock.redemption.findMany).toHaveBeenCalledTimes(2);
  });
});

describe("getTopVouchers", () => {
  test("ranks vouchers by redemptions within the window", async () => {
    prismaMock.redemption.findMany.mockResolvedValue([
      { wealthAmount: "10", voucher: { id: "v1", title: "Kopi", merchant: { name: "Alpha" } } },
      { wealthAmount: "20", voucher: { id: "v1", title: "Kopi", merchant: { name: "Alpha" } } },
      { wealthAmount: "5", voucher: { id: "v2", title: "Teh", merchant: { name: "Beta" } } },
    ] as never);

    const result = await getTopVouchers("monthly", 3);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      voucherId: "v1",
      voucherTitle: "Kopi",
      merchantName: "Alpha",
      redemptionCount: 2,
      wealthVolume: "30.0000",
    });
    expect(result[1].voucherId).toBe("v2");
  });

  test("query is window-scoped to CONFIRMED + createdAt >= startDate", async () => {
    prismaMock.redemption.findMany.mockResolvedValue([] as never);

    await getTopVouchers("yearly", 3);

    const where = prismaMock.redemption.findMany.mock.calls[0][0]?.where as {
      status: string;
      createdAt: { gte: Date };
    };
    expect(where.status).toBe("CONFIRMED");
    expect(where.createdAt.gte).toBeInstanceOf(Date);
  });

  test("merchant-scoped call adds voucher.merchantId filter", async () => {
    prismaMock.redemption.findMany.mockResolvedValue([] as never);

    await getTopVouchers("monthly", 3, "merchant-1");

    const where = prismaMock.redemption.findMany.mock.calls[0][0]?.where as {
      voucher: { merchantId: string };
    };
    expect(where.voucher.merchantId).toBe("merchant-1");
  });
});
