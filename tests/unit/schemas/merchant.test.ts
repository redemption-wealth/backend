import { describe, test, expect } from "vitest";
import {
  createMerchantSchema,
  updateMerchantSchema,
  merchantQuerySchema,
} from "@/schemas/merchant.js";

// UAT B16 — create/edit merchant
describe("createMerchantSchema", () => {
  test("positive: minimal valid (name only) passes", () => {
    expect(createMerchantSchema.safeParse({ name: "Kopi Kita" }).success).toBe(
      true,
    );
  });

  test("positive: full payload with valid category + logoUrl passes", () => {
    expect(
      createMerchantSchema.safeParse({
        name: "Kopi Kita",
        description: "Kedai kopi",
        category: "F&B",
        logoUrl: "https://cdn.example.com/logo.png",
      }).success,
    ).toBe(true);
  });

  test("negative: name shorter than 2 chars rejected", () => {
    expect(createMerchantSchema.safeParse({ name: "K" }).success).toBe(false);
  });

  test("negative: invalid category enum rejected", () => {
    expect(
      createMerchantSchema.safeParse({ name: "Kopi", category: "otomotif" })
        .success,
    ).toBe(false);
  });

  test("negative: non-URL logoUrl rejected", () => {
    expect(
      createMerchantSchema.safeParse({ name: "Kopi", logoUrl: "not-a-url" })
        .success,
    ).toBe(false);
  });

  test("edge: name exactly 200 chars accepted, 201 rejected", () => {
    expect(
      createMerchantSchema.safeParse({ name: "a".repeat(200) }).success,
    ).toBe(true);
    expect(
      createMerchantSchema.safeParse({ name: "a".repeat(201) }).success,
    ).toBe(false);
  });
});

describe("updateMerchantSchema", () => {
  test("positive: empty object passes (all optional)", () => {
    expect(updateMerchantSchema.safeParse({}).success).toBe(true);
  });

  test("positive: isActive toggle + nullable description/logo", () => {
    expect(
      updateMerchantSchema.safeParse({
        isActive: false,
        description: null,
        logoUrl: null,
      }).success,
    ).toBe(true);
  });

  test("negative: invalid category rejected", () => {
    expect(
      updateMerchantSchema.safeParse({ category: "bogus" }).success,
    ).toBe(false);
  });
});

describe("merchantQuerySchema", () => {
  test("positive: defaults applied", () => {
    const r = merchantQuerySchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.page).toBe(1);
      expect(r.data.limit).toBe(20);
    }
  });

  test("negative: search over 100 chars rejected", () => {
    expect(
      merchantQuerySchema.safeParse({ search: "a".repeat(101) }).success,
    ).toBe(false);
  });
});
