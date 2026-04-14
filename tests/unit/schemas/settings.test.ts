import { describe, test, expect } from "vitest";
import { updateSettingsSchema } from "@/schemas/settings.js";

describe("updateSettingsSchema", () => {
  test("valid settings pass", () => {
    const result = updateSettingsSchema.safeParse({
      appFeeRate: 5,
    });
    expect(result.success).toBe(true);
  });

  test("empty object passes (all optional)", () => {
    const result = updateSettingsSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  test("appFeeRate > 50 fails", () => {
    const result = updateSettingsSchema.safeParse({
      appFeeRate: 51,
    });
    expect(result.success).toBe(false);
  });

  test("appFeeRate negative fails", () => {
    const result = updateSettingsSchema.safeParse({
      appFeeRate: -1,
    });
    expect(result.success).toBe(false);
  });

  test("appFeeRate=0 passes", () => {
    const result = updateSettingsSchema.safeParse({
      appFeeRate: 0,
    });
    expect(result.success).toBe(true);
  });

  test("appFeeRate=50 passes", () => {
    const result = updateSettingsSchema.safeParse({
      appFeeRate: 50,
    });
    expect(result.success).toBe(true);
  });

  test("all fields with valid wallet address passes", () => {
    const result = updateSettingsSchema.safeParse({
      appFeeRate: 3,
      wealthContractAddress: "0x1234567890abcdef1234567890abcdef12345678",
      devWalletAddress: "0xabcdef1234567890abcdef1234567890abcdef12",
      alchemyRpcUrl: "https://eth-mainnet.g.alchemy.com/v2/key",
      coingeckoApiKey: "CG-test-key",
    });
    expect(result.success).toBe(true);
  });

  test("null address values pass", () => {
    const result = updateSettingsSchema.safeParse({
      wealthContractAddress: null,
      devWalletAddress: null,
    });
    expect(result.success).toBe(true);
  });

  test("invalid wallet address fails", () => {
    const result = updateSettingsSchema.safeParse({
      devWalletAddress: "not-a-wallet",
    });
    expect(result.success).toBe(false);
  });
});
