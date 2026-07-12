import { describe, test, expect } from "vitest";
import { deriveTier } from "@/lib/wp-tiers.js";

describe("deriveTier", () => {
  test("Bronze below Silver threshold", () => {
    expect(deriveTier(0)).toBe("Bronze");
    expect(deriveTier(24_999)).toBe("Bronze");
  });

  test("Silver at/above 25k, below 100k", () => {
    expect(deriveTier(25_000)).toBe("Silver");
    expect(deriveTier(99_999)).toBe("Silver");
  });

  test("Gold at/above 100k", () => {
    expect(deriveTier(100_000)).toBe("Gold");
    expect(deriveTier(5_000_000)).toBe("Gold");
  });
});
