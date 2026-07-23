import { describe, test, expect } from "vitest";
import {
  parseLadder,
  claimableTiers,
  DEFAULT_MILESTONE_LADDER,
  tierReward,
} from "@/services/quest.js";

// Pure (no-DB) unit coverage for the tiered-milestone ladder maths. These back
// the tiered claim path + the GET /api/quests tier state, so they must be exact.

describe("parseLadder", () => {
  test("null → the default ladder, ascending", () => {
    expect(parseLadder(null)).toEqual([1, 3, 5, 10, 20, 30, 50, 100]);
    expect(DEFAULT_MILESTONE_LADDER).toBe("1,3,5,10,20,30,50,100");
  });

  test("empty / whitespace → default ladder", () => {
    expect(parseLadder("")).toEqual([1, 3, 5, 10, 20, 30, 50, 100]);
    expect(parseLadder("   ")).toEqual([1, 3, 5, 10, 20, 30, 50, 100]);
  });

  test("parses a CSV, sorts ascending, drops junk/dupes/non-positives", () => {
    expect(parseLadder("5, 1 ,3,3, x, 0, -2, 10")).toEqual([1, 3, 5, 10]);
  });
});

describe("claimableTiers", () => {
  test("progress 12, default ladder, none completed → [1,3,5,10]", () => {
    expect(claimableTiers(12, null, [])).toEqual([1, 3, 5, 10]);
  });

  test("progress 12, default ladder, completed [1,3] → [5,10]", () => {
    expect(claimableTiers(12, null, [1, 3])).toEqual([5, 10]);
  });

  test("a jump in progress unlocks every tier ≤ progress at once", () => {
    expect(claimableTiers(100, null, [])).toEqual([
      1, 3, 5, 10, 20, 30, 50, 100,
    ]);
  });

  test("progress below the first tier → nothing claimable", () => {
    expect(claimableTiers(0, null, [])).toEqual([]);
  });

  test("honours a custom ladder CSV", () => {
    expect(claimableTiers(7, "2,4,6,8", [2])).toEqual([4, 6]);
  });
});

describe("tierReward", () => {
  test("reward for tier T = T * milestoneBaseWp", () => {
    expect(tierReward(5, 10)).toBe(50);
    expect(tierReward(1, 30)).toBe(30);
  });
});
