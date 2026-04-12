import { describe, test, expect } from "vitest";
import {
  createFeeSettingSchema,
  updateFeeSettingSchema,
} from "@/schemas/fee-setting.js";

describe("createFeeSettingSchema", () => {
  test("valid fee data passes", () => {
    const result = createFeeSettingSchema.safeParse({
      label: "Gas Fee",
      amountIdr: 5000,
    });
    expect(result.success).toBe(true);
  });

  test("amountIdr=0 passes", () => {
    const result = createFeeSettingSchema.safeParse({
      label: "Free Fee",
      amountIdr: 0,
    });
    expect(result.success).toBe(true);
  });

  test("negative amountIdr fails", () => {
    const result = createFeeSettingSchema.safeParse({
      label: "Bad Fee",
      amountIdr: -100,
    });
    expect(result.success).toBe(false);
  });

  test("empty label fails", () => {
    const result = createFeeSettingSchema.safeParse({
      label: "",
      amountIdr: 5000,
    });
    expect(result.success).toBe(false);
  });

  test("label too short fails", () => {
    const result = createFeeSettingSchema.safeParse({
      label: "A",
      amountIdr: 5000,
    });
    expect(result.success).toBe(false);
  });

  test("label too long fails", () => {
    const result = createFeeSettingSchema.safeParse({
      label: "A".repeat(101),
      amountIdr: 5000,
    });
    expect(result.success).toBe(false);
  });

  test("missing fields fails", () => {
    const result = createFeeSettingSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  test("non-integer amountIdr fails", () => {
    const result = createFeeSettingSchema.safeParse({
      label: "Fee",
      amountIdr: 50.5,
    });
    expect(result.success).toBe(false);
  });
});

describe("updateFeeSettingSchema", () => {
  test("partial update passes", () => {
    const result = updateFeeSettingSchema.safeParse({ label: "Updated" });
    expect(result.success).toBe(true);
  });

  test("empty object passes", () => {
    const result = updateFeeSettingSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  test("amountIdr only update passes", () => {
    const result = updateFeeSettingSchema.safeParse({ amountIdr: 3000 });
    expect(result.success).toBe(true);
  });

  test("negative amountIdr fails", () => {
    const result = updateFeeSettingSchema.safeParse({ amountIdr: -1 });
    expect(result.success).toBe(false);
  });
});
