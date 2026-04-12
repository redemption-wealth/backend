import { Hono } from "hono";
import { getWealthPrice } from "../services/price.js";

const price = new Hono();

// GET /api/price/wealth — Get $WEALTH price in IDR
price.get("/wealth", async (c) => {
  try {
    const result = await getWealthPrice();
    return c.json(result);
  } catch {
    return c.json({ error: "Failed to fetch price" }, 500);
  }
});

export default price;
