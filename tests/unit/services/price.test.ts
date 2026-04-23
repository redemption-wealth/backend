import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { getWealthPrice, resetPriceCache } from "@/services/price.js";

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  resetPriceCache();
  process.env = {
    ...ORIGINAL_ENV,
    CMC_API_KEY: "test-key",
    WEALTH_CMC_SLUG: "wealth-crypto",
  };
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
});

function jsonResponse(data: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: () => Promise.resolve(data),
  } as Response;
}

function cmcPayload(slug: string, priceUsd: number) {
  return {
    status: { error_code: 0 },
    data: {
      "39108": { id: 39108, slug, symbol: "WEALTH", quote: { USD: { price: priceUsd } } },
    },
  };
}

function fxPayload(rate: number) {
  return { result: "success", rates: { IDR: rate } };
}

function mockFetchSequence(...responses: Response[]) {
  const queue = [...responses];
  return vi.fn().mockImplementation(() => {
    const next = queue.shift();
    if (!next) throw new Error("No more mocked responses");
    return Promise.resolve(next);
  });
}

describe("getWealthPrice", () => {
  test("multiplies CMC USD price by USD→IDR to get IDR", async () => {
    const fetchFn = mockFetchSequence(
      jsonResponse(cmcPayload("wealth-crypto", 10)),
      jsonResponse(fxPayload(16500)),
    );
    const result = await getWealthPrice(fetchFn);
    expect(result.priceIdr).toBe(165000);
    expect(result.cached).toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  test("returns cached price within TTL", async () => {
    const fetchFn = mockFetchSequence(
      jsonResponse(cmcPayload("wealth-crypto", 10)),
      jsonResponse(fxPayload(16500)),
    );
    await getWealthPrice(fetchFn);
    const second = await getWealthPrice(fetchFn);
    expect(second.priceIdr).toBe(165000);
    expect(second.cached).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  test("returns stale cache when fetch fails", async () => {
    vi.useFakeTimers();
    const goodFetch = mockFetchSequence(
      jsonResponse(cmcPayload("wealth-crypto", 10)),
      jsonResponse(fxPayload(16500)),
    );
    await getWealthPrice(goodFetch);
    vi.advanceTimersByTime(61_000);
    const failFetch = vi.fn().mockRejectedValue(new Error("boom"));
    const result = await getWealthPrice(failFetch);
    expect(result.priceIdr).toBe(165000);
    expect(result.cached).toBe(true);
    expect(result.stale).toBe(true);
    vi.useRealTimers();
  });

  test("throws when CMC_API_KEY is missing", async () => {
    delete process.env.CMC_API_KEY;
    const fetchFn = vi.fn();
    await expect(getWealthPrice(fetchFn)).rejects.toThrow("Failed to fetch price");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test("throws when slug is not present in CMC data", async () => {
    const fetchFn = mockFetchSequence(
      jsonResponse({ status: {}, data: {} }),
      jsonResponse(fxPayload(16500)),
    );
    await expect(getWealthPrice(fetchFn)).rejects.toThrow("Failed to fetch price");
  });

  test("throws on non-200 CMC response", async () => {
    const fetchFn = mockFetchSequence(
      jsonResponse({}, false, 401),
      jsonResponse(fxPayload(16500)),
    );
    await expect(getWealthPrice(fetchFn)).rejects.toThrow("Failed to fetch price");
  });

  test("throws on malformed FX response", async () => {
    const fetchFn = mockFetchSequence(
      jsonResponse(cmcPayload("wealth-crypto", 10)),
      jsonResponse({ rates: {} }),
    );
    await expect(getWealthPrice(fetchFn)).rejects.toThrow("Failed to fetch price");
  });
});
