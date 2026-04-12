import { describe, test, expect } from "vitest";
import { paginationSchema, uuidParamSchema } from "@/schemas/common.js";

describe("paginationSchema", () => {
  test("valid pagination passes", () => {
    const result = paginationSchema.safeParse({ page: 1, limit: 20 });
    expect(result.success).toBe(true);
  });

  test("defaults page=1 and limit=20", () => {
    const result = paginationSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.page).toBe(1);
      expect(result.data.limit).toBe(20);
    }
  });

  test("coerces string values", () => {
    const result = paginationSchema.safeParse({ page: "2", limit: "10" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.page).toBe(2);
      expect(result.data.limit).toBe(10);
    }
  });

  test("page=0 fails", () => {
    const result = paginationSchema.safeParse({ page: 0 });
    expect(result.success).toBe(false);
  });

  test("limit=0 fails", () => {
    const result = paginationSchema.safeParse({ limit: 0 });
    expect(result.success).toBe(false);
  });

  test("limit=101 fails", () => {
    const result = paginationSchema.safeParse({ limit: 101 });
    expect(result.success).toBe(false);
  });

  test("page=-1 fails", () => {
    const result = paginationSchema.safeParse({ page: -1 });
    expect(result.success).toBe(false);
  });
});

describe("uuidParamSchema", () => {
  test("valid UUID passes", () => {
    const result = uuidParamSchema.safeParse({
      id: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(result.success).toBe(true);
  });

  test("non-UUID fails", () => {
    const result = uuidParamSchema.safeParse({ id: "not-a-uuid" });
    expect(result.success).toBe(false);
  });

  test("empty string fails", () => {
    const result = uuidParamSchema.safeParse({ id: "" });
    expect(result.success).toBe(false);
  });
});
