import { Hono } from "hono";
import { prisma } from "../db.js";
import { requireAdmin, requireOwner } from "../middleware/auth.js";

const merchants = new Hono();

// GET /api/merchants — Public: list active merchants
merchants.get("/", async (c) => {
  const category = c.req.query("category");
  const search = c.req.query("search");
  const page = parseInt(c.req.query("page") ?? "1");
  const limit = parseInt(c.req.query("limit") ?? "20");

  const where = {
    isActive: true,
    ...(category && { category: category as never }),
    ...(search && {
      name: { contains: search, mode: "insensitive" as const },
    }),
  };

  const [merchants, total] = await Promise.all([
    prisma.merchant.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.merchant.count({ where }),
  ]);

  return c.json({
    merchants,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  });
});

// GET /api/merchants/:id — Public: get merchant details
merchants.get("/:id", async (c) => {
  const id = c.req.param("id");

  const merchant = await prisma.merchant.findUnique({
    where: { id },
    include: { vouchers: { where: { isActive: true } } },
  });

  if (!merchant) {
    return c.json({ error: "Merchant not found" }, 404);
  }

  return c.json({ merchant });
});

export default merchants;
