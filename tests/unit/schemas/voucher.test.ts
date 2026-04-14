import { describe, test, expect } from "vitest";
import {
  createVoucherSchema,
  updateVoucherSchema,
  redeemVoucherSchema,
  voucherQuerySchema,
} from "@/schemas/voucher.js";

describe("createVoucherSchema", () => {
  const validData = {
    merchantId: "550e8400-e29b-41d4-a716-446655440000",
    title: "Test Voucher",
    startDate: "2026-01-01",
    expiryDate: "2026-12-31",
    totalStock: 10,
    basePrice: 25000,
  };

  test("valid voucher data passes", () => {
    const result = createVoucherSchema.safeParse(validData);
    expect(result.success).toBe(true);
  });

  test("defaults qrPerSlot to 1", () => {
    const result = createVoucherSchema.safeParse(validData);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.qrPerSlot).toBe(1);
    }
  });

  test("qrPerSlot=2 passes", () => {
    const result = createVoucherSchema.safeParse({
      ...validData,
      qrPerSlot: 2,
    });
    expect(result.success).toBe(true);
  });

  test("qrPerSlot=0 fails", () => {
    const result = createVoucherSchema.safeParse({
      ...validData,
      qrPerSlot: 0,
    });
    expect(result.success).toBe(false);
  });

  test("qrPerSlot=3 fails", () => {
    const result = createVoucherSchema.safeParse({
      ...validData,
      qrPerSlot: 3,
    });
    expect(result.success).toBe(false);
  });

  test("expiryDate before startDate fails", () => {
    const result = createVoucherSchema.safeParse({
      ...validData,
      startDate: "2026-12-31",
      expiryDate: "2026-01-01",
    });
    expect(result.success).toBe(false);
  });

  test("negative totalStock fails", () => {
    const result = createVoucherSchema.safeParse({
      ...validData,
      totalStock: -1,
    });
    expect(result.success).toBe(false);
  });

  test("zero totalStock fails", () => {
    const result = createVoucherSchema.safeParse({
      ...validData,
      totalStock: 0,
    });
    expect(result.success).toBe(false);
  });

  test("basePrice < 1000 fails", () => {
    const result = createVoucherSchema.safeParse({
      ...validData,
      basePrice: 999,
    });
    expect(result.success).toBe(false);
  });

  test("non-UUID merchantId fails", () => {
    const result = createVoucherSchema.safeParse({
      ...validData,
      merchantId: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });

  test("missing title fails", () => {
    const { title, ...noTitle } = validData;
    const result = createVoucherSchema.safeParse(noTitle);
    expect(result.success).toBe(false);
  });
});

describe("updateVoucherSchema", () => {
  test("partial update passes", () => {
    const result = updateVoucherSchema.safeParse({ title: "Updated" });
    expect(result.success).toBe(true);
  });

  test("empty object passes", () => {
    const result = updateVoucherSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  test("does not accept qrPerSlot (immutable)", () => {
    const result = updateVoucherSchema.safeParse({ qrPerSlot: 2 });
    // It should pass parse but qrPerSlot is stripped (not in schema)
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).qrPerSlot).toBeUndefined();
    }
  });
});

describe("redeemVoucherSchema", () => {
  test("valid redeem data passes", () => {
    const result = redeemVoucherSchema.safeParse({
      idempotencyKey: "550e8400-e29b-41d4-a716-446655440000",
      wealthPriceIdr: 850,
    });
    expect(result.success).toBe(true);
  });

  test("wealthPriceIdr=0 fails", () => {
    const result = redeemVoucherSchema.safeParse({
      idempotencyKey: "550e8400-e29b-41d4-a716-446655440000",
      wealthPriceIdr: 0,
    });
    expect(result.success).toBe(false);
  });

  test("negative wealthPriceIdr fails", () => {
    const result = redeemVoucherSchema.safeParse({
      idempotencyKey: "550e8400-e29b-41d4-a716-446655440000",
      wealthPriceIdr: -1,
    });
    expect(result.success).toBe(false);
  });

  test("non-UUID idempotencyKey fails", () => {
    const result = redeemVoucherSchema.safeParse({
      idempotencyKey: "not-uuid",
      wealthPriceIdr: 850,
    });
    expect(result.success).toBe(false);
  });

  test("missing wealthPriceIdr fails", () => {
    const result = redeemVoucherSchema.safeParse({
      idempotencyKey: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(result.success).toBe(false);
  });
});

describe("voucherQuerySchema", () => {
  test("empty query uses defaults", () => {
    const result = voucherQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.page).toBe(1);
      expect(result.data.limit).toBe(20);
    }
  });

  test("valid merchantId filter passes", () => {
    const result = voucherQuerySchema.safeParse({
      merchantId: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(result.success).toBe(true);
  });

  test("non-UUID merchantId fails", () => {
    const result = voucherQuerySchema.safeParse({ merchantId: "bad" });
    expect(result.success).toBe(false);
  });
});
