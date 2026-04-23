import { describe, test, expect, beforeEach, vi, afterEach } from "vitest";
import app from "@/app.js";
import { resetPriceCache } from "@/services/price.js";

const mockFetch = vi.fn();
global.fetch = mockFetch as typeof fetch;

const ORIGINAL_ENV = process.env;

function cmcResponse(priceUsd: number): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      status: { error_code: 0 },
      data: {
        "39108": {
          id: 39108,
          slug: "wealth-crypto",
          symbol: "WEALTH",
          quote: { USD: { price: priceUsd } },
        },
      },
    }),
  } as Response;
}

function fxResponse(rate: number): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ result: "success", rates: { IDR: rate } }),
  } as Response;
}

describe("GET /api/price/wealth", () => {
  beforeEach(() => {
    resetPriceCache();
    mockFetch.mockClear();
    process.env = {
      ...ORIGINAL_ENV,
      CMC_API_KEY: "test-key",
      WEALTH_CMC_SLUG: "wealth-crypto",
    };
  });

  afterEach(() => {
    mockFetch.mockClear();
    process.env = ORIGINAL_ENV;
  });

  test("returns price computed from CMC USD and USD→IDR rate", async () => {
    mockFetch
      .mockResolvedValueOnce(cmcResponse(10))
      .mockResolvedValueOnce(fxResponse(16500));

    const res = await app.request("/api/price/wealth");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.priceIdr).toBe(165000);
    expect(body.cached).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test("returns cached price on repeated calls within TTL", async () => {
    mockFetch
      .mockResolvedValueOnce(cmcResponse(10))
      .mockResolvedValueOnce(fxResponse(16500));

    const res1 = await app.request("/api/price/wealth");
    expect((await res1.json()).cached).toBe(false);

    const res2 = await app.request("/api/price/wealth");
    const body2 = await res2.json();
    expect(body2.priceIdr).toBe(165000);
    expect(body2.cached).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test("returns 500 when CMC fetch fails and no cache", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network error"));
    const res = await app.request("/api/price/wealth");
    expect(res.status).toBe(500);
  });

  test("returns 500 when CMC_API_KEY is missing", async () => {
    delete process.env.CMC_API_KEY;
    const res = await app.request("/api/price/wealth");
    expect(res.status).toBe(500);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("returns 500 on malformed CMC response", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: {}, data: {} }),
      } as Response)
      .mockResolvedValueOnce(fxResponse(16500));

    const res = await app.request("/api/price/wealth");
    expect(res.status).toBe(500);
  });

  test("returns 500 on non-ok CMC response", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 401 } as Response)
      .mockResolvedValueOnce(fxResponse(16500));

    const res = await app.request("/api/price/wealth");
    expect(res.status).toBe(500);
  });
});
