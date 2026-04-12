import { describe, test, expect } from "vitest";
import {
  createMerchantSchema,
  updateMerchantSchema,
  merchantQuerySchema,
} from "@/schemas/merchant.js";

describe("createMerchantSchema", () => {
  test("valid merchant data passes", () => {
    const result = createMerchantSchema.safeParse({
      name: "Test Merchant",
      category: "kuliner",
    });
    expect(result.success).toBe(true);
  });

  test("valid with all optional fields", () => {
    const result = createMerchantSchema.safeParse({
      name: "Test Merchant",
      category: "kuliner",
      description: "A great merchant",
      logoUrl: "https://example.com/logo.png",
    });
    expect(result.success).toBe(true);
  });

  test("name too short fails", () => {
    const result = createMerchantSchema.safeParse({
      name: "A",
      category: "kuliner",
    });
    expect(result.success).toBe(false);
  });

  test("name too long fails", () => {
    const result = createMerchantSchema.safeParse({
      name: "A".repeat(201),
      category: "kuliner",
    });
    expect(result.success).toBe(false);
  });

  test("invalid category enum fails", () => {
    const result = createMerchantSchema.safeParse({
      name: "Test",
      category: "invalid_category",
    });
    expect(result.success).toBe(false);
  });

  test("invalid URL format for logoUrl fails", () => {
    const result = createMerchantSchema.safeParse({
      name: "Test",
      category: "kuliner",
      logoUrl: "not-a-url",
    });
    expect(result.success).toBe(false);
  });

  test("all valid categories pass", () => {
    const categories = [
      "kuliner",
      "hiburan",
      "event",
      "kesehatan",
      "lifestyle",
      "travel",
    ];
    for (const category of categories) {
      const result = createMerchantSchema.safeParse({
        name: "Test",
        category,
      });
      expect(result.success).toBe(true);
    }
  });

  test("missing name fails", () => {
    const result = createMerchantSchema.safeParse({ category: "kuliner" });
    expect(result.success).toBe(false);
  });

  test("missing category fails", () => {
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

  test("valid category filter passes", () => {
    const result = merchantQuerySchema.safeParse({ category: "kuliner" });
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
