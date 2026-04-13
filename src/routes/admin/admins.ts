import { Hono } from "hono";
import bcryptjs from "bcryptjs";
import { prisma } from "../../db.js";
import { requireOwner, type AuthEnv } from "../../middleware/auth.js";
import { createAdminSchema, updateAdminSchema } from "../../schemas/admin.js";

const adminAdmins = new Hono<AuthEnv>();

// All routes require owner
adminAdmins.use("/*", requireOwner);

// GET /api/admin/admins — List all admins
adminAdmins.get("/", async (c) => {
  const admins = await prisma.admin.findMany({
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
  });

  return c.json({ admins });
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

// DELETE /api/admin/admins/:id — Delete admin (owner only)
adminAdmins.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const currentAdmin = c.get("adminAuth");

  if (currentAdmin.adminId === id) {
    return c.json({ error: "Cannot delete yourself" }, 400);
  }

  const target = await prisma.admin.findUnique({ where: { id } });
  if (!target) {
    return c.json({ error: "Admin not found" }, 404);
  }

  if (target.role === "owner") {
    const ownerCount = await prisma.admin.count({
      where: { role: "owner", isActive: true },
    });
    if (ownerCount <= 1) {
      return c.json({ error: "Cannot delete the last owner" }, 400);
    }
  }

  await prisma.admin.delete({ where: { id } });
  return c.json({ ok: true });
});

export default adminAdmins;
