import { describe, test, expect } from "vitest";
import { updateSettingsSchema } from "@/schemas/settings.js";

// UAT B21 — App Fee Rate (%) + Gas Fee (IDR) config
describe("updateSettingsSchema", () => {
  test("positive: appFeeRate only passes", () => {
    expect(updateSettingsSchema.safeParse({ appFeeRate: 5 }).success).toBe(true);
  });

  test("positive: gasFeeAmount only passes", () => {
    expect(
      updateSettingsSchema.safeParse({ gasFeeAmount: 5000 }).success,
    ).toBe(true);
  });

  test("positive: both fields pass", () => {
    expect(
      updateSettingsSchema.safeParse({ appFeeRate: 3, gasFeeAmount: 0 }).success,
    ).toBe(true);
  });

  test("positive: empty object passes (all optional)", () => {
    expect(updateSettingsSchema.safeParse({}).success).toBe(true);
  });

  test("edge: appFeeRate 0 and 50 pass; -1 and 51 fail", () => {
    expect(updateSettingsSchema.safeParse({ appFeeRate: 0 }).success).toBe(true);
    expect(updateSettingsSchema.safeParse({ appFeeRate: 50 }).success).toBe(
      true,
    );
    expect(updateSettingsSchema.safeParse({ appFeeRate: -1 }).success).toBe(
      false,
    );
    expect(updateSettingsSchema.safeParse({ appFeeRate: 51 }).success).toBe(
      false,
    );
  });

  test("edge: gasFeeAmount 0 passes, negative fails", () => {
    expect(updateSettingsSchema.safeParse({ gasFeeAmount: 0 }).success).toBe(
      true,
    );
    expect(
      updateSettingsSchema.safeParse({ gasFeeAmount: -100 }).success,
    ).toBe(false);
  });

  test("negative: non-numeric appFeeRate rejected", () => {
    expect(
      updateSettingsSchema.safeParse({ appFeeRate: "3" }).success,
    ).toBe(false);
  });

  test("edge: unknown keys are stripped, not rejected", () => {
    const r = updateSettingsSchema.safeParse({
      appFeeRate: 3,
      devWalletAddress: "not-a-wallet",
    });
    expect(r.success).toBe(true);
    if (r.success)
      expect((r.data as Record<string, unknown>).devWalletAddress).toBeUndefined();
  });
});
