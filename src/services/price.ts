let cachedPrice: { price: number; updatedAt: number } | null = null;
const CACHE_TTL = 60_000; // 60 seconds

const COINGECKO_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=wealth&vs_currencies=idr";

export async function getWealthPrice(
  fetchFn: typeof fetch = fetch
): Promise<{ priceIdr: number; cached: boolean; stale?: boolean }> {
  const now = Date.now();

  if (cachedPrice && now - cachedPrice.updatedAt < CACHE_TTL) {
    return { priceIdr: cachedPrice.price, cached: true };
  }

  try {
    const res = await fetchFn(COINGECKO_URL, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`CoinGecko returned ${res.status}`);
    const data = await res.json();
    if (!data?.wealth?.idr || typeof data.wealth.idr !== "number") {
      throw new Error("Malformed CoinGecko response");
    }
    const price = data.wealth.idr;
    cachedPrice = { price, updatedAt: now };
    return { priceIdr: price, cached: false };
  } catch {
    if (cachedPrice) {
      return { priceIdr: cachedPrice.price, cached: true, stale: true };
    }
    throw new Error("Failed to fetch price");
  }
}

export function resetPriceCache() {
  cachedPrice = null;
}
