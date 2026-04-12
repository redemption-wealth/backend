import { describe, test, expect } from "vitest";
import { updateSettingsSchema } from "@/schemas/settings.js";

describe("updateSettingsSchema", () => {
  test("valid settings pass", () => {
    const result = updateSettingsSchema.safeParse({
      appFeePercentage: 5,
    });
    expect(result.success).toBe(true);
  });

  test("empty object passes (all optional)", () => {
    const result = updateSettingsSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  test("appFeePercentage > 100 fails", () => {
    const result = updateSettingsSchema.safeParse({
      appFeePercentage: 101,
    });
    expect(result.success).toBe(false);
  });

  test("appFeePercentage negative fails", () => {
    const result = updateSettingsSchema.safeParse({
      appFeePercentage: -1,
    });
    expect(result.success).toBe(false);
  });

  test("appFeePercentage=0 passes", () => {
    const result = updateSettingsSchema.safeParse({
      appFeePercentage: 0,
    });
    expect(result.success).toBe(true);
  });

  test("appFeePercentage=100 passes", () => {
    const result = updateSettingsSchema.safeParse({
      appFeePercentage: 100,
    });
    expect(result.success).toBe(true);
  });

  test("all fields passes", () => {
    const result = updateSettingsSchema.safeParse({
      appFeePercentage: 3,
      tokenContractAddress: "0x1234567890abcdef",
      treasuryWalletAddress: "0xabcdef1234567890",
    });
    expect(result.success).toBe(true);
  });

  test("null address values pass", () => {
    const result = updateSettingsSchema.safeParse({
      tokenContractAddress: null,
      treasuryWalletAddress: null,
    });
    expect(result.success).toBe(true);
  });
});
