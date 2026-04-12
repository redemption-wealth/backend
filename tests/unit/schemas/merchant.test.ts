import { describe, test, expect } from "vitest";
import {
  createMerchantSchema,
  updateMerchantSchema,
  merchantQuerySchema,
} from "@/schemas/merchant.js";

describe("createMerchantSchema", () => {
  const mockCategoryId = "123e4567-e89b-12d3-a456-426614174000";

  test("valid merchant data passes", () => {
    const result = createMerchantSchema.safeParse({
      name: "Test Merchant",
      categoryId: mockCategoryId,
    });
    expect(result.success).toBe(true);
  });

  test("valid with all optional fields", () => {
    const result = createMerchantSchema.safeParse({
      name: "Test Merchant",
      categoryId: mockCategoryId,
      description: "A great merchant",
      logoUrl: "https://example.com/logo.png",
    });
    expect(result.success).toBe(true);
  });

  test("name too short fails", () => {
    const result = createMerchantSchema.safeParse({
      name: "A",
      categoryId: mockCategoryId,
    });
    expect(result.success).toBe(false);
  });

  test("name too long fails", () => {
    const result = createMerchantSchema.safeParse({
      name: "A".repeat(201),
      categoryId: mockCategoryId,
    });
    expect(result.success).toBe(false);
  });

  test("invalid categoryId format fails", () => {
    const result = createMerchantSchema.safeParse({
      name: "Test",
      categoryId: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });

  test("invalid URL format for logoUrl fails", () => {
    const result = createMerchantSchema.safeParse({
      name: "Test",
      categoryId: mockCategoryId,
      logoUrl: "not-a-url",
    });
    expect(result.success).toBe(false);
  });

  test("valid categoryId UUID passes", () => {
    const validUUIDs = [
      "123e4567-e89b-12d3-a456-426614174000",
      "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      "550e8400-e29b-41d4-a716-446655440000",
    ];
    for (const categoryId of validUUIDs) {
      const result = createMerchantSchema.safeParse({
        name: "Test",
        categoryId,
      });
      expect(result.success).toBe(true);
    }
  });

  test("missing name fails", () => {
    const result = createMerchantSchema.safeParse({ categoryId: mockCategoryId });
    expect(result.success).toBe(false);
  });

  test("missing categoryId fails", () => {
    const result = createMerchantSchema.safeParse({ name: "Test" });
    expect(result.success).toBe(false);
  });
});

describe("updateMerchantSchema", () => {
  test("partial update passes", () => {
    const result = updateMerchantSchema.safeParse({ name: "Updated" });
    expect(result.success).toBe(true);
  });

  test("empty object passes (all optional)", () => {
    const result = updateMerchantSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  test("isActive boolean passes", () => {
    const result = updateMerchantSchema.safeParse({ isActive: false });
    expect(result.success).toBe(true);
  });
});

describe("merchantQuerySchema", () => {
  test("empty query uses defaults", () => {
    const result = merchantQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.page).toBe(1);
      expect(result.data.limit).toBe(20);
    }
  });

  test("valid categoryId filter passes", () => {
    const result = merchantQuerySchema.safeParse({
      categoryId: "123e4567-e89b-12d3-a456-426614174000"
    });
    expect(result.success).toBe(true);
  });

  test("search too long fails", () => {
    const result = merchantQuerySchema.safeParse({
      search: "A".repeat(101),
    });
    expect(result.success).toBe(false);
  });

  test("page=0 fails", () => {
    const result = merchantQuerySchema.safeParse({ page: 0 });
    expect(result.success).toBe(false);
  });

  test("limit=101 fails", () => {
    const result = merchantQuerySchema.safeParse({ limit: 101 });
    expect(result.success).toBe(false);
  });
});
