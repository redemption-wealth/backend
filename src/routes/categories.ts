import { Hono } from "hono";
import { prisma } from "../db.js";

const app = new Hono();

/**
 * GET /api/categories
 * Get all active categories
 */
app.get("/", async (c) => {
  const categories = await prisma.category.findMany({
    where: { isActive: true },
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
    },
  });

  return c.json({ data: categories });
});

/**
 * GET /api/categories/:id
 * Get a specific category by ID
 */
app.get("/:id", async (c) => {
  const { id } = c.req.param();

  const category = await prisma.category.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      isActive: true,
    },
  });

  if (!category) {
    return c.json({ error: "Category not found" }, 404);
  }

  return c.json({ data: category });
});

export default app;
