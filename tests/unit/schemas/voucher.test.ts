import { describe, test, expect } from "vitest";
import {
  createVoucherSchema,
  updateVoucherSchema,
  redeemVoucherSchema,
  voucherQuerySchema,
} from "@/schemas/voucher.js";

const base = {
  merchantId: "m_123",
  title: "Voucher Kopi",
  startDate: "2026-01-01",
  expiryDate: "2026-12-31",
  totalStock: 10,
  basePrice: 25000,
};

// UAT B18 — create voucher
describe("createVoucherSchema", () => {
  test("positive: valid payload passes, qrPerSlot defaults to 1", () => {
    const r = createVoucherSchema.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.qrPerSlot).toBe(1);
  });

  // UAT B19 — Buy 1 Get 1
  test("positive: qrPerSlot = 2 accepted", () => {
    expect(
      createVoucherSchema.safeParse({ ...base, qrPerSlot: 2 }).success,
    ).toBe(true);
  });

  test("negative: qrPerSlot = 3 rejected (max 2)", () => {
    expect(
      createVoucherSchema.safeParse({ ...base, qrPerSlot: 3 }).success,
    ).toBe(false);
  });

  test("negative: basePrice below 1000 rejected", () => {
    expect(
      createVoucherSchema.safeParse({ ...base, basePrice: 999 }).success,
    ).toBe(false);
  });

  test("edge: basePrice exactly 1000 accepted", () => {
    expect(
      createVoucherSchema.safeParse({ ...base, basePrice: 1000 }).success,
    ).toBe(true);
  });

  test("negative: totalStock zero/negative/float rejected", () => {
    expect(createVoucherSchema.safeParse({ ...base, totalStock: 0 }).success).toBe(
      false,
    );
    expect(
      createVoucherSchema.safeParse({ ...base, totalStock: -1 }).success,
    ).toBe(false);
    expect(
      createVoucherSchema.safeParse({ ...base, totalStock: 1.5 }).success,
    ).toBe(false);
  });

  test("negative: expiryDate before startDate rejected (refine path)", () => {
    const r = createVoucherSchema.safeParse({
      ...base,
      startDate: "2026-12-31",
      expiryDate: "2026-01-01",
    });
    expect(r.success).toBe(false);
    if (!r.success)
      expect(r.error.issues.some((i) => i.path.includes("expiryDate"))).toBe(
        true,
      );
  });

  test("edge: expiryDate equal to startDate accepted (>=)", () => {
    expect(
      createVoucherSchema.safeParse({
        ...base,
        startDate: "2026-06-01",
        expiryDate: "2026-06-01",
      }).success,
    ).toBe(true);
  });

  test("negative: title shorter than 2 chars rejected", () => {
    expect(createVoucherSchema.safeParse({ ...base, title: "x" }).success).toBe(
      false,
    );
  });
});

describe("updateVoucherSchema", () => {
  test("positive: partial update (only totalStock) passes", () => {
    expect(updateVoucherSchema.safeParse({ totalStock: 50 }).success).toBe(true);
  });

  test("positive: empty object passes (all optional)", () => {
    expect(updateVoucherSchema.safeParse({}).success).toBe(true);
  });

  test("negative: totalStock negative rejected", () => {
    expect(updateVoucherSchema.safeParse({ totalStock: -5 }).success).toBe(
      false,
    );
  });

  test("positive: description nullable", () => {
    expect(updateVoucherSchema.safeParse({ description: null }).success).toBe(
      true,
    );
  });
});

// UAT A10 — redeem idempotency key must be a UUID
describe("redeemVoucherSchema", () => {
  test("positive: valid uuid passes", () => {
    expect(
      redeemVoucherSchema.safeParse({
        idempotencyKey: "550e8400-e29b-41d4-a716-446655440000",
      }).success,
    ).toBe(true);
  });

  test("negative: non-uuid string rejected", () => {
    expect(
      redeemVoucherSchema.safeParse({ idempotencyKey: "not-a-uuid" }).success,
    ).toBe(false);
  });

  test("negative: missing key rejected", () => {
    expect(redeemVoucherSchema.safeParse({}).success).toBe(false);
  });
});

describe("voucherQuerySchema", () => {
  test("positive: defaults page=1 limit=20", () => {
    const r = voucherQuerySchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.page).toBe(1);
      expect(r.data.limit).toBe(20);
    }
  });

  test("positive: coerces string numbers", () => {
    const r = voucherQuerySchema.safeParse({ page: "2", limit: "50" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.page).toBe(2);
  });

  test("negative: limit above 100 rejected", () => {
    expect(voucherQuerySchema.safeParse({ limit: "101" }).success).toBe(false);
  });
});
