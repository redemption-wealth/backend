import { describe, test, expect } from "vitest";
import { Prisma } from "@prisma/client";
import { calcTotalPrice } from "@/services/pricing.js";

const D = (v: string | number) => new Prisma.Decimal(v);

// UAT B21/D5 — total price = basePrice + basePrice*appFeeRate/100 + gasFee,
// rounded 2dp ROUND_HALF_UP
describe("calcTotalPrice", () => {
  test("positive: standard 25000 + 3% + 5000 = 30750", () => {
    expect(calcTotalPrice(D(25000), D(3), D(5000)).toString()).toBe("30750");
  });

  test("positive: zero appFee and zero gas → basePrice", () => {
    expect(calcTotalPrice(D(25000), D(0), D(0)).toString()).toBe("25000");
  });

  test("positive: decimal appFeeRate handled", () => {
    // 50000 * 2.5% = 1250 → 51250
    expect(calcTotalPrice(D(50000), D("2.5"), D(0)).toString()).toBe("51250");
  });

  test("edge: ROUND_HALF_UP rounds 3rd decimal .005 up", () => {
    // 1000 * 0.1255% = 1.255 → total 1001.255 → 2dp HALF_UP → 1001.26
    expect(calcTotalPrice(D(1000), D("0.1255"), D(0)).toString()).toBe(
      "1001.26",
    );
  });

  test("edge: result already at 2dp is unchanged", () => {
    expect(calcTotalPrice(D(1000), D("0.125"), D(0)).toString()).toBe(
      "1001.25",
    );
  });

  test("edge: large values do not overflow", () => {
    expect(
      calcTotalPrice(D(1_000_000_000), D(10), D(500000)).toString(),
    ).toBe("1100500000");
  });

  test("positive: gasFee with decimals added", () => {
    expect(calcTotalPrice(D(10000), D(0), D("2500.50")).toString()).toBe(
      "12500.5",
    );
  });
});
