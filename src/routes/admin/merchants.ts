import { Hono } from "hono";
import { prisma } from "../../db.js";
import { requireOwner, requireManager, type AuthEnv } from "../../middleware/auth.js";
import {
  createMerchantSchema,
  updateMerchantSchema,
  merchantQuerySchema,
} from "../../schemas/merchant.js";

const adminMerchants = new Hono<AuthEnv>();

const notDeleted = { deletedAt: null };

// GET /api/admin/merchants/select — Merchants with no active admin (owner only)
adminMerchants.get("/select", requireOwner, async (c) => {
  const merchants = await prisma.merchant.findMany({
    where: {
      ...notDeleted,
      admins: { none: { isActive: true } },
    },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });

  return c.json({ merchants });
});

// GET /api/admin/merchants/:id — Get merchant detail
adminMerchants.get("/:id", async (c) => {
  const id = c.req.param("id");
  const adminAuth = c.get("adminAuth");

  const merchant = await prisma.merchant.findUnique({ where: { id } });

  if (!merchant || merchant.deletedAt) {
    return c.json({ error: "Merchant not found" }, 404);
  }

  if (adminAuth.role === "ADMIN" && merchant.id !== adminAuth.merchantId) {
    return c.json({ error: "Access denied" }, 403);
  }

  return c.json({ merchant });
});

// GET /api/admin/merchants — List all merchants
adminMerchants.get("/", async (c) => {
  const query = merchantQuerySchema.safeParse({
    category: c.req.query("category") || undefined,
    search: c.req.query("search") || undefined,
    page: c.req.query("page"),
    limit: c.req.query("limit"),
  });

  if (!query.success) {
    return c.json({ error: "Validation failed", details: query.error.flatten() }, 400);
  }

  const { category, search, page, limit } = query.data;

  const where = {
    ...notDeleted,
    ...(category && { category }),
    ...(search && { name: { contains: search, mode: "insensitive" as const } }),
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
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
});

// POST /api/admin/merchants — Create merchant (manager only)
adminMerchants.post("/", requireManager, async (c) => {
  const body = await c.req.json();

  const parsed = createMerchantSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
  }

  const merchant = await prisma.merchant.create({ data: parsed.data });
  return c.json({ merchant }, 201);
});

// PUT /api/admin/merchants/:id — Update merchant (manager only)
adminMerchants.put("/:id", requireManager, async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();

  const parsed = updateMerchantSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
  }

  try {
    const merchant = await prisma.merchant.update({ where: { id }, data: parsed.data });
    return c.json({ merchant });
  } catch {
    return c.json({ error: "Merchant not found" }, 404);
  }
});

// POST /api/admin/merchants/:id/toggle-active — Toggle merchant active status (manager only)
adminMerchants.post("/:id/toggle-active", requireManager, async (c) => {
  const id = c.req.param("id");
  const merchant = await prisma.merchant.findFirst({
    where: { id, deletedAt: null },
  });
  if (!merchant) return c.json({ error: "Merchant not found" }, 404);

  const updated = await prisma.merchant.update({
    where: { id },
    data: { isActive: !merchant.isActive },
  });
  return c.json({ merchant: updated });
});

// DELETE /api/admin/merchants/:id — Soft delete (manager only)
adminMerchants.delete("/:id", requireManager, async (c) => {
  const id = c.req.param("id");

  const merchant = await prisma.merchant.findUnique({ where: { id } });
  if (!merchant || merchant.deletedAt) {
    return c.json({ error: "Merchant not found" }, 404);
  }

  try {
    await prisma.merchant.update({ where: { id }, data: { deletedAt: new Date() } });
    return c.json({ ok: true });
  } catch {
    return c.json({ error: "Merchant not found" }, 404);
  }
});

export default adminMerchants;
