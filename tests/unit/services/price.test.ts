import { describe, test, expect, vi, beforeEach } from "vitest";
import { getWealthPrice, resetPriceCache } from "@/services/price.js";

beforeEach(() => {
  resetPriceCache();
});

function mockFetch(data: unknown, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: () => Promise.resolve(data),
  } as Response);
}

describe("getWealthPrice", () => {
  test("returns fresh price on cache miss", async () => {
    const fetchFn = mockFetch({ wealth: { idr: 850 } });
    const result = await getWealthPrice(fetchFn);
    expect(result.priceIdr).toBe(850);
    expect(result.cached).toBe(false);
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  test("returns cached price on cache hit", async () => {
    const fetchFn = mockFetch({ wealth: { idr: 850 } });
    await getWealthPrice(fetchFn);
    const result = await getWealthPrice(fetchFn);
    expect(result.priceIdr).toBe(850);
    expect(result.cached).toBe(true);
    expect(fetchFn).toHaveBeenCalledOnce(); // Only first call
  });

  test("returns stale cache when API fails", async () => {
    // Populate cache first
    const goodFetch = mockFetch({ wealth: { idr: 900 } });
    await getWealthPrice(goodFetch);

    // Now the cache is fresh, but a subsequent call within TTL returns cached
    // To test stale, we need to wait for cache expiry. Instead, test that
    // a failure with existing cache returns cached data.
    // Reset and re-populate with a short-lived entry by manipulating time
    resetPriceCache();

    // Use vi.useFakeTimers to simulate cache expiry
    vi.useFakeTimers();
    await getWealthPrice(goodFetch);

    // Advance time past cache TTL (60s)
    vi.advanceTimersByTime(61_000);

    const failFetch = vi.fn().mockRejectedValue(new Error("Network error"));
    const result = await getWealthPrice(failFetch);
    expect(result.priceIdr).toBe(900);
    expect(result.cached).toBe(true);
    expect(result.stale).toBe(true);

    vi.useRealTimers();
  });

  test("throws when API fails and no cache", async () => {
    const failFetch = vi.fn().mockRejectedValue(new Error("Network error"));
    await expect(getWealthPrice(failFetch)).rejects.toThrow(
      "Failed to fetch price"
    );
  });

  test("handles malformed CoinGecko response", async () => {
    const fetchFn = mockFetch({ invalid: "data" });
    await expect(getWealthPrice(fetchFn)).rejects.toThrow(
      "Failed to fetch price"
    );
  });

  test("handles non-200 response", async () => {
    const fetchFn = mockFetch({}, false, 429);
    await expect(getWealthPrice(fetchFn)).rejects.toThrow(
      "Failed to fetch price"
    );
  });
});
