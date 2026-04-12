import { Hono } from "hono";

const price = new Hono();

let cachedPrice: { price: number; updatedAt: number } | null = null;
const CACHE_TTL = 60_000; // 60 seconds

// GET /api/price/wealth — Get $WEALTH price in IDR
price.get("/wealth", async (c) => {
  const now = Date.now();

  if (cachedPrice && now - cachedPrice.updatedAt < CACHE_TTL) {
    return c.json({
      priceIdr: cachedPrice.price,
      cached: true,
    });
  }

  try {
    // TODO: Replace with real CoinGecko API call
    // const res = await fetch(
    //   "https://api.coingecko.com/api/v3/simple/price?ids=wealth&vs_currencies=idr"
    // );
    // const data = await res.json();
    // const price = data.wealth.idr;

    const mockPrice = 850; // Mock price: 850 IDR per $WEALTH

    cachedPrice = { price: mockPrice, updatedAt: now };

    return c.json({
      priceIdr: mockPrice,
      cached: false,
    });
  } catch {
    if (cachedPrice) {
      return c.json({
        priceIdr: cachedPrice.price,
        cached: true,
        stale: true,
      });
    }

    return c.json({ error: "Failed to fetch price" }, 500);
  }
});

export default price;
