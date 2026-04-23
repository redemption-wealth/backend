import { Hono } from "hono";
import bcryptjs from "bcryptjs";
import { prisma } from "../../db.js";
import { requireOwner, type AuthEnv } from "../../middleware/auth.js";
import { createAdminSchema, updateAdminSchema, adminQuerySchema } from "../../schemas/admin.js";

const adminAdmins = new Hono<AuthEnv>();

// Soft delete helper
const notDeleted = { deletedAt: null };

// All routes require owner
adminAdmins.use("/*", requireOwner);

// GET /api/admin/admins — List all admins with filtering and pagination
adminAdmins.get("/", async (c) => {
  const query = adminQuerySchema.safeParse({
    role: c.req.query("role") || undefined,
    isActive: c.req.query("isActive") || undefined,
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

  const { role, isActive, search, page, limit } = query.data;

  const where = {
    ...notDeleted,
    ...(role && { role }),
    ...(isActive !== undefined && { isActive }),
    ...(search && {
      email: { contains: search, mode: "insensitive" as const },
    }),
  };

  const [admins, total] = await Promise.all([
    prisma.admin.findMany({
      where,
      select: {
        id: true,
        email: true,
        role: true,
        merchantId: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
        assignedMerchant: {
          select: { id: true, name: true },
        },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.admin.count({ where }),
  ]);

  return c.json({
    admins,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  });
});

// GET /api/admin/admins/:id — Get admin detail
adminAdmins.get("/:id", async (c) => {
  const id = c.req.param("id");

  const admin = await prisma.admin.findUnique({
    where: { id },
    select: {
      id: true,
      email: true,
      role: true,
      merchantId: true,
      isActive: true,
      deletedAt: true,
      createdAt: true,
      updatedAt: true,
      assignedMerchant: {
        select: { id: true, name: true },
      },
    },
  });

  if (!admin || admin.deletedAt) {
    return c.json({ error: "Admin not found" }, 404);
  }

  return c.json({ admin });
});

// POST /api/admin/admins — Create admin (owner only)
adminAdmins.post("/", async (c) => {
  const body = await c.req.json();

  const parsed = createAdminSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      400
    );
  }

  const { email, password, role, merchantId } = parsed.data;

  // Check if email already used by an active (non-deleted) admin
  const existingAdmin = await prisma.admin.findFirst({
    where: { email, ...notDeleted },
    select: { id: true },
  });
  if (existingAdmin) {
    return c.json({ error: "Email already exists" }, 409);
  }

  // Verify merchant exists if merchantId provided
  if (merchantId) {
    const merchant = await prisma.merchant.findUnique({
      where: { id: merchantId },
      select: { id: true },
    });
    if (!merchant) {
      return c.json({ error: "Merchant not found" }, 404);
    }
  }

  const passwordHash = password ? await bcryptjs.hash(password, 12) : null;

  try {
    const admin = await prisma.admin.create({
      data: { email, passwordHash, role, merchantId: merchantId ?? null },
      select: {
        id: true,
        email: true,
        role: true,
        merchantId: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return c.json({ admin }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("Unique constraint")) {
      return c.json({ error: "Email already exists" }, 400);
    }
    return c.json({ error: "Failed to create admin" }, 400);
  }
});

// PUT /api/admin/admins/:id — Update admin (owner only)
adminAdmins.put("/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();

  const parsed = updateAdminSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      400
    );
  }

  const { isActive, merchantId } = parsed.data;

  // Validate merchantId updates
  if (merchantId !== undefined) {
    const target = await prisma.admin.findUnique({
      where: { id },
      select: { role: true },
    });
    if (!target) {
      return c.json({ error: "Admin not found" }, 404);
    }
    if (target.role !== "admin") {
      return c.json({ error: "merchantId can only be set for admin role" }, 400);
    }

    // Verify merchant exists if setting a non-null value
    if (merchantId !== null) {
      const merchant = await prisma.merchant.findUnique({
        where: { id: merchantId },
        select: { id: true },
      });
      if (!merchant) {
        return c.json({ error: "Merchant not found" }, 404);
      }
    }
  }

  try {
    const updateData: Record<string, unknown> = {};
    if (isActive !== undefined) updateData.isActive = isActive;
    if (merchantId !== undefined) updateData.merchantId = merchantId;

    const admin = await prisma.admin.update({
      where: { id },
      data: updateData,
      select: {
        id: true,
        email: true,
        role: true,
        merchantId: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return c.json({ admin });
  } catch {
    return c.json({ error: "Admin not found" }, 404);
  }
});

// POST /api/admin/admins/:id/reset-password — Reset admin password (owner only)
adminAdmins.post("/:id/reset-password", async (c) => {
  const id = c.req.param("id");
  const currentAdmin = c.get("adminAuth");

  if (currentAdmin.adminId === id) {
    return c.json({ error: "Cannot reset your own password", code: "CANNOT_RESET_SELF" }, 400);
  }

  const target = await prisma.admin.findUnique({ where: { id } });
  if (!target || target.deletedAt) {
    return c.json({ error: "Admin not found" }, 404);
  }

  if (target.role === "owner") {
    const ownerCount = await prisma.admin.count({
      where: { role: "owner", isActive: true, deletedAt: null },
    });
    if (ownerCount <= 1) {
      return c.json({ error: "Cannot reset password of the last active owner", code: "CANNOT_RESET_LAST_OWNER" }, 400);
    }
  }

  await prisma.admin.update({
    where: { id },
    data: { passwordHash: null },
  });

  return c.json({ ok: true });
});

// DELETE /api/admin/admins/:id — Soft delete admin (owner only)
adminAdmins.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const currentAdmin = c.get("adminAuth");

  if (currentAdmin.adminId === id) {
    return c.json({ error: "Cannot delete yourself" }, 400);
  }

  const target = await prisma.admin.findUnique({ where: { id } });
  if (!target || target.deletedAt) {
    return c.json({ error: "Admin not found" }, 404);
  }

  if (target.role === "owner") {
    const ownerCount = await prisma.admin.count({
      where: { role: "owner", isActive: true, deletedAt: null },
    });
    if (ownerCount <= 1) {
      return c.json({ error: "Cannot delete the last owner" }, 400);
    }
  }

  await prisma.admin.update({
    where: { id },
    data: { deletedAt: new Date() },
  });
  return c.json({ ok: true });
});

export default adminAdmins;
