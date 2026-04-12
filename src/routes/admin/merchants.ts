import { Hono } from "hono";
import { prisma } from "../../db.js";
import { requireOwner, type AuthEnv } from "../../middleware/auth.js";

const adminMerchants = new Hono<AuthEnv>();

// GET /api/admin/merchants — List all merchants (including inactive)
adminMerchants.get("/", async (c) => {
  const category = c.req.query("category");
  const search = c.req.query("search");
  const page = parseInt(c.req.query("page") ?? "1");
  const limit = parseInt(c.req.query("limit") ?? "20");

  const where = {
    ...(category && { category: category as never }),
    ...(search && {
      name: { contains: search, mode: "insensitive" as const },
    }),
  };

  const [merchants, total] = await Promise.all([
    prisma.merchant.findMany({
      where,
      include: { creator: { select: { email: true } } },
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

// POST /api/admin/merchants — Create merchant
adminMerchants.post("/", async (c) => {
  const admin = c.get("adminAuth");
  const { name, description, category, logoUrl } = await c.req.json();

  const merchant = await prisma.merchant.create({
    data: {
      name,
      description,
      category,
      logoUrl,
      createdBy: admin.adminId,
    },
  });

  return c.json({ merchant }, 201);
});

// PUT /api/admin/merchants/:id — Update merchant
adminMerchants.put("/:id", async (c) => {
  const id = c.req.param("id");
  const { name, description, category, logoUrl, isActive } =
    await c.req.json();

  const merchant = await prisma.merchant.update({
    where: { id },
    data: { name, description, category, logoUrl, isActive },
  });

  return c.json({ merchant });
});

// DELETE /api/admin/merchants/:id — Delete merchant (owner only)
adminMerchants.delete("/:id", requireOwner, async (c) => {
  const id = c.req.param("id");
  await prisma.merchant.delete({ where: { id } });
  return c.json({ ok: true });
});

export default adminMerchants;
