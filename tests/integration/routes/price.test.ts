import { describe, test, expect, beforeEach, vi, afterEach } from "vitest";
import app from "@/app.js";
import { resetPriceCache } from "@/services/price.js";

// Mock fetch globally for these tests
const mockFetch = vi.fn();
global.fetch = mockFetch as typeof fetch;

describe("GET /api/price/wealth", () => {
  beforeEach(() => {
    // Reset cache before each test
    resetPriceCache();
    mockFetch.mockClear();
  });

  afterEach(() => {
    mockFetch.mockClear();
  });

  test("returns price from CoinGecko", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        wealth: {
          idr: 850.5,
        },
      }),
    } as Response);

    const res = await app.request("/api/price/wealth");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.priceIdr).toBe(850.5);
    expect(body.cached).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test("returns cached price on repeated calls", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        wealth: {
          idr: 850.5,
        },
      }),
    } as Response);

    // First call - should hit API
    const res1 = await app.request("/api/price/wealth");
    const body1 = await res1.json();
    expect(body1.cached).toBe(false);

    // Second call - should use cache
    const res2 = await app.request("/api/price/wealth");
    const body2 = await res2.json();
    expect(body2.priceIdr).toBe(850.5);
    expect(body2.cached).toBe(true);

    // Should only call API once
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test("uses cache when fresh to avoid API calls", async () => {
    // First successful call to populate cache
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        wealth: {
          idr: 850.5,
        },
      }),
    } as Response);

    await app.request("/api/price/wealth");

    // Clear mock to verify no new call is made
    mockFetch.mockClear();

    // Second call should use cache without hitting API
    const res = await app.request("/api/price/wealth");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.priceIdr).toBe(850.5);
    expect(body.cached).toBe(true);
    // Verify no API call was made
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("returns 500 when API fails and no cache", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network error"));

    const res = await app.request("/api/price/wealth");
    expect(res.status).toBe(500);
  });

  test("handles malformed CoinGecko response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        // Missing wealth.idr
        something: "else",
      }),
    } as Response);

    const res = await app.request("/api/price/wealth");
    expect(res.status).toBe(500);
  });

  test("handles non-ok HTTP response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
    } as Response);

    const res = await app.request("/api/price/wealth");
    expect(res.status).toBe(500);
  });
});
