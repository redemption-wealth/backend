let cachedPrice: { price: number; updatedAt: number } | null = null;
let cachedFx: { usdToIdr: number; updatedAt: number } | null = null;

const PRICE_CACHE_TTL = 60_000;
const FX_CACHE_TTL = 15 * 60_000;
const REQUEST_TIMEOUT_MS = 5_000;

const CMC_QUOTES_URL =
  "https://pro-api.coinmarketcap.com/v2/cryptocurrency/quotes/latest";
const FX_URL = "https://open.er-api.com/v6/latest/USD";

function parseCmcQuote(json: unknown, slug: string): number {
  const data = (json as { data?: Record<string, unknown> } | null)?.data;
  if (!data || typeof data !== "object") {
    throw new Error("Malformed CMC response");
  }
  const entries = Object.values(data);
  const entry = entries.find(
    (e) => (e as { slug?: string })?.slug === slug,
  ) as { quote?: { USD?: { price?: number } } } | undefined;
  const price = entry?.quote?.USD?.price;
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) {
    throw new Error("Malformed CMC response");
  }
  return price;
}

function parseFxRate(json: unknown): number {
  const rate = (json as { rates?: { IDR?: number } } | null)?.rates?.IDR;
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) {
    throw new Error("Malformed FX response");
  }
  return rate;
}

async function fetchUsdPrice(
  fetchFn: typeof fetch,
  apiKey: string,
  slug: string,
): Promise<number> {
  const url = `${CMC_QUOTES_URL}?slug=${encodeURIComponent(slug)}&convert=USD`;
  const res = await fetchFn(url, {
    headers: {
      "X-CMC_PRO_API_KEY": apiKey,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`CMC returned ${res.status}`);
  return parseCmcQuote(await res.json(), slug);
}

async function fetchUsdToIdr(fetchFn: typeof fetch): Promise<number> {
  const now = Date.now();
  if (cachedFx && now - cachedFx.updatedAt < FX_CACHE_TTL) {
    return cachedFx.usdToIdr;
  }
  const res = await fetchFn(FX_URL, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`FX returned ${res.status}`);
  const rate = parseFxRate(await res.json());
  cachedFx = { usdToIdr: rate, updatedAt: now };
  return rate;
}

export async function getWealthPrice(
  fetchFn: typeof fetch = fetch,
): Promise<{ priceIdr: number; cached: boolean; stale?: boolean }> {
  const now = Date.now();

  if (cachedPrice && now - cachedPrice.updatedAt < PRICE_CACHE_TTL) {
    return { priceIdr: cachedPrice.price, cached: true };
  }

  try {
    const apiKey = process.env.CMC_API_KEY;
    if (!apiKey) throw new Error("CMC_API_KEY is not configured");
    const slug = process.env.WEALTH_CMC_SLUG ?? "wealth-crypto";

    const [priceUsd, usdToIdr] = await Promise.all([
      fetchUsdPrice(fetchFn, apiKey, slug),
      fetchUsdToIdr(fetchFn),
    ]);

    const priceIdr = priceUsd * usdToIdr;
    cachedPrice = { price: priceIdr, updatedAt: now };
    return { priceIdr, cached: false };
  } catch {
    if (cachedPrice) {
      return { priceIdr: cachedPrice.price, cached: true, stale: true };
    }
    throw new Error("Failed to fetch price");
  }
}

export function resetPriceCache() {
  cachedPrice = null;
  cachedFx = null;
}
