import { describe, test, expect, beforeEach } from "vitest";
import { prismaMock } from "../../mocks/prisma.js";
import {
  getWpMetrics,
  getMerchantAnalytics,
  getVoucherAnalytics,
  getMerchantListEnrichment,
  clearAnalyticsCache,
} from "@/services/analytics.js";

beforeEach(() => clearAnalyticsCache());

// ─── WP metrics ──────────────────────────────────────────────────────────────

describe("getWpMetrics", () => {
  test("totals, current-vs-previous delta, and zero-filled series", async () => {
    // aggregate order: total (all-time), current window, previous window
    prismaMock.wpLedger.aggregate
      .mockResolvedValueOnce({ _sum: { amount: 5000 } } as never)
      .mockResolvedValueOnce({ _sum: { amount: 300 } } as never)
      .mockResolvedValueOnce({ _sum: { amount: 150 } } as never);
    // series source rows — two issuances "now" (land in the latest bucket)
    prismaMock.wpLedger.findMany.mockResolvedValue([
      { createdAt: new Date(), amount: 100 },
      { createdAt: new Date(), amount: 200 },
    ] as never);

    const result = await getWpMetrics("monthly");

    expect(result.totalDistributed).toBe(5000);
    expect(result.distributed).toEqual({ current: 300, previous: 150, deltaPct: 100 });
    // monthly → 6 buckets, gap-free
    expect(result.series).toHaveLength(6);
    // all rows are "now" → the newest bucket carries their sum, others are 0
    const totalInSeries = result.series.reduce((s, b) => s + b.wp, 0);
    expect(totalInSeries).toBe(300);
    expect(result.series[result.series.length - 1].wp).toBe(300);
    expect(result.series[0].wp).toBe(0);
  });

  test("empty economy → zeros and deltaPct null when previous is 0", async () => {
    prismaMock.wpLedger.aggregate
      .mockResolvedValueOnce({ _sum: { amount: null } } as never)
      .mockResolvedValueOnce({ _sum: { amount: null } } as never)
      .mockResolvedValueOnce({ _sum: { amount: null } } as never);
    prismaMock.wpLedger.findMany.mockResolvedValue([] as never);

    const result = await getWpMetrics("daily");

    expect(result.totalDistributed).toBe(0);
    expect(result.distributed).toEqual({ current: 0, previous: 0, deltaPct: null });
    expect(result.series).toHaveLength(7); // daily → 7 buckets
    expect(result.series.every((b) => b.wp === 0)).toBe(true);
  });
});

// ─── Merchant detail analytics ───────────────────────────────────────────────

describe("getMerchantAnalytics", () => {
  test("confirmed redemption count + $WEALTH volume (4dp string)", async () => {
    prismaMock.redemption.count.mockResolvedValue(12 as never);
    prismaMock.redemption.aggregate.mockResolvedValue({
      _sum: { wealthAmount: "123.456789" },
    } as never);

    const result = await getMerchantAnalytics("merchant-1");

    expect(result.totalRedemptions).toBe(12);
    expect(result.wealthVolume).toBe("123.4568");
  });

  test("empty merchant → 0 count and '0.0000' volume", async () => {
    prismaMock.redemption.count.mockResolvedValue(0 as never);
    prismaMock.redemption.aggregate.mockResolvedValue({
      _sum: { wealthAmount: null },
    } as never);

    const result = await getMerchantAnalytics("merchant-empty");

    expect(result.totalRedemptions).toBe(0);
    expect(result.wealthVolume).toBe("0.0000");
  });
});

// ─── Voucher detail analytics ────────────────────────────────────────────────

describe("getVoucherAnalytics", () => {
  test("confirmed redemption count + $WEALTH volume (4dp string)", async () => {
    prismaMock.redemption.count.mockResolvedValue(4 as never);
    prismaMock.redemption.aggregate.mockResolvedValue({
      _sum: { wealthAmount: "10.5" },
    } as never);

    const result = await getVoucherAnalytics("voucher-1");

    expect(result.redemptionCount).toBe(4);
    expect(result.wealthVolume).toBe("10.5000");
  });

  test("unused voucher → 0 count and '0.0000' volume", async () => {
    prismaMock.redemption.count.mockResolvedValue(0 as never);
    prismaMock.redemption.aggregate.mockResolvedValue({
      _sum: { wealthAmount: null },
    } as never);

    const result = await getVoucherAnalytics("voucher-unused");

    expect(result.redemptionCount).toBe(0);
    expect(result.wealthVolume).toBe("0.0000");
  });
});

// ─── Merchant list enrichment (no N+1) ───────────────────────────────────────

describe("getMerchantListEnrichment", () => {
  test("maps voucher counts and assigned admins per merchant in one pass each", async () => {
    prismaMock.voucher.groupBy.mockResolvedValue([
      { merchantId: "m1", _count: { _all: 3 } },
      { merchantId: "m2", _count: { _all: 1 } },
    ] as never);
    prismaMock.admin.findMany.mockResolvedValue([
      { id: "a1", merchantId: "m1", user: { email: "a1@x.com" } },
      { id: "a2", merchantId: "m1", user: { email: "a2@x.com" } },
    ] as never);

    const result = await getMerchantListEnrichment(["m1", "m2", "m3"]);

    // exactly one groupBy + one findMany, regardless of page size (no N+1)
    expect(prismaMock.voucher.groupBy).toHaveBeenCalledTimes(1);
    expect(prismaMock.admin.findMany).toHaveBeenCalledTimes(1);

    expect(result.get("m1")).toEqual({
      voucherCount: 3,
      assignedAdmins: [
        { id: "a1", email: "a1@x.com" },
        { id: "a2", email: "a2@x.com" },
      ],
    });
    expect(result.get("m2")).toEqual({ voucherCount: 1, assignedAdmins: [] });
    // m3 has neither vouchers nor admins → defaults
    expect(result.get("m3")).toEqual({ voucherCount: 0, assignedAdmins: [] });
  });

  test("empty id list → empty map, no queries", async () => {
    const result = await getMerchantListEnrichment([]);

    expect(result.size).toBe(0);
    expect(prismaMock.voucher.groupBy).not.toHaveBeenCalled();
    expect(prismaMock.admin.findMany).not.toHaveBeenCalled();
  });
});
