import { Hono } from "hono";
import { prisma } from "../../db.js";
import { requireOwner, requireManager, type AuthEnv } from "../../middleware/auth.js";
import {
  createMerchantSchema,
  updateMerchantSchema,
  merchantQuerySchema,
} from "../../schemas/merchant.js";

const adminMerchants = new Hono<AuthEnv>();

// Soft delete helper
const notDeleted = { deletedAt: null };

// GET /api/admin/merchants/select — Get unassigned merchants for dropdown (owner only)
adminMerchants.get("/select", requireOwner, async (c) => {
  const merchants = await prisma.merchant.findMany({
    where: {
      ...notDeleted,
      assignedAdmins: {
        none: {
          isActive: true,
          deletedAt: null,
        },
      },
    },
    select: {
      id: true,
      name: true,
    },
    orderBy: { name: "asc" },
  });

  return c.json({ merchants });
});

// GET /api/admin/merchants/:id — Get merchant detail
adminMerchants.get("/:id", async (c) => {
  const id = c.req.param("id");
  const adminAuth = c.get("adminAuth");

  const merchant = await prisma.merchant.findUnique({
    where: { id },
    include: {
      creator: { select: { email: true } },
      category: { select: { name: true } },
    },
  });

  if (!merchant || merchant.deletedAt) {
    return c.json({ error: "Merchant not found" }, 404);
  }

  // Admin role: enforce merchant ownership
  if (adminAuth.role === "admin" && merchant.id !== adminAuth.merchantId) {
    return c.json({ error: "Access denied" }, 403);
  }

  return c.json({ merchant });
});

// GET /api/admin/merchants — List all merchants (any authenticated admin)
adminMerchants.get("/", async (c) => {
  const query = merchantQuerySchema.safeParse({
    categoryId: c.req.query("categoryId") || undefined,
    search: c.req.query("search") || undefined,
    page: c.req.query("page"),
    limit: c.req.query("limit"),
  });

  if (!query.success) {
    return c.json(
      { error: "Validation failed", details: query.error.flatten() },
      400
    );
  }

  const { categoryId, search, page, limit } = query.data;

  const where = {
    ...notDeleted,
    ...(categoryId && { categoryId }),
    ...(search && {
      name: { contains: search, mode: "insensitive" as const },
    }),
  };

  const [merchants, total] = await Promise.all([
    prisma.merchant.findMany({
      where,
      include: {
        creator: { select: { email: true } },
        category: { select: { name: true } },
      },
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

// POST /api/admin/merchants — Create merchant (manager+ only)
adminMerchants.post("/", requireManager, async (c) => {
  const admin = c.get("adminAuth");
  const body = await c.req.json();

  const parsed = createMerchantSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      400
    );
  }

  const merchant = await prisma.merchant.create({
    data: {
      ...parsed.data,
      createdBy: admin.adminId,
    },
  });

  return c.json({ merchant }, 201);
});

// PUT /api/admin/merchants/:id — Update merchant (manager+ only)
adminMerchants.put("/:id", requireManager, async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();

  const parsed = updateMerchantSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      400
    );
  }

  try {
    const merchant = await prisma.merchant.update({
      where: { id },
      data: parsed.data,
    });
    return c.json({ merchant });
  } catch {
    return c.json({ error: "Merchant not found" }, 404);
  }
});

// DELETE /api/admin/merchants/:id — Soft delete merchant (manager+ only)
adminMerchants.delete("/:id", requireManager, async (c) => {
  const id = c.req.param("id");

  const merchant = await prisma.merchant.findUnique({ where: { id } });
  if (!merchant || merchant.deletedAt) {
    return c.json({ error: "Merchant not found" }, 404);
  }

  try {
    await prisma.merchant.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    return c.json({ ok: true });
  } catch {
    return c.json({ error: "Merchant not found" }, 404);
  }
});

export default adminMerchants;
