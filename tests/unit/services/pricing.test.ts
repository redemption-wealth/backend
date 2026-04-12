import { describe, test, expect } from "vitest";
import { calculatePricing } from "@/services/pricing.js";
import { Prisma } from "@prisma/client";

describe("calculatePricing (3-component)", () => {
  test("standard calculation", () => {
    // priceIdr=25000, appFee=3%, gasFee=5000, wealthPrice=850
    // appFeeInIdr = 25000 * 3 / 100 = 750
    // totalIdr = 25000 + 750 + 5000 = 30750
    // wealthAmount = 30750 / 850 ≈ 36.17647...
    // appFeeAmount = 750 / 850 ≈ 0.88235...
    // gasFeeAmount = 5000 / 850 ≈ 5.88235...
    const result = calculatePricing({
      priceIdr: 25000,
      appFeePercentage: 3,
      gasFeeIdr: 5000,
      wealthPriceIdr: 850,
    });

    expect(result.totalIdr.toString()).toBe("30750");
    // Use toNumber() for approximate comparisons
    expect(result.wealthAmount.toNumber()).toBeCloseTo(36.1765, 3);
    expect(result.appFeeAmount.toNumber()).toBeCloseTo(0.8824, 3);
    expect(result.gasFeeAmount.toNumber()).toBeCloseTo(5.8824, 3);
  });

  test("zero gas fee", () => {
    const result = calculatePricing({
      priceIdr: 25000,
      appFeePercentage: 3,
      gasFeeIdr: 0,
      wealthPriceIdr: 850,
    });

    expect(result.totalIdr.toString()).toBe("25750");
    expect(result.gasFeeAmount.toNumber()).toBe(0);
  });

  test("large values don't overflow", () => {
    const result = calculatePricing({
      priceIdr: 1000000000,
      appFeePercentage: 10,
      gasFeeIdr: 500000,
      wealthPriceIdr: 1,
    });

    expect(result.totalIdr.toString()).toBe("1100500000");
    expect(result.wealthAmount.toString()).toBe("1100500000");
  });

  test("very small wealthPriceIdr produces large WEALTH amount", () => {
    const result = calculatePricing({
      priceIdr: 25000,
      appFeePercentage: 3,
      gasFeeIdr: 5000,
      wealthPriceIdr: 0.1,
    });

    expect(result.wealthAmount.toNumber()).toBeCloseTo(307500, 0);
  });

  test("appFeeAmount calculated correctly", () => {
    const result = calculatePricing({
      priceIdr: 50000,
      appFeePercentage: 5,
      gasFeeIdr: 0,
      wealthPriceIdr: 1000,
    });

    // appFeeInIdr = 50000 * 5 / 100 = 2500
    // appFeeAmount = 2500 / 1000 = 2.5
    expect(result.appFeeAmount.toNumber()).toBe(2.5);
  });

  test("gasFeeAmount calculated correctly", () => {
    const result = calculatePricing({
      priceIdr: 0,
      appFeePercentage: 0,
      gasFeeIdr: 10000,
      wealthPriceIdr: 500,
    });

    // gasFeeAmount = 10000 / 500 = 20
    expect(result.gasFeeAmount.toNumber()).toBe(20);
  });

  test("accepts Decimal for appFeePercentage", () => {
    const result = calculatePricing({
      priceIdr: 25000,
      appFeePercentage: new Prisma.Decimal(3) as unknown as number,
      gasFeeIdr: 5000,
      wealthPriceIdr: 850,
    });

    expect(result.totalIdr.toString()).toBe("30750");
  });
});
