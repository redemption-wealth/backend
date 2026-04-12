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
      isActive: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy: { createdAt: "desc" },
  });

  return c.json({ admins });
});

// POST /api/admin/admins — Create admin
adminAdmins.post("/", async (c) => {
  const body = await c.req.json();

  const parsed = createAdminSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      400
    );
  }

  const { email, password, role } = parsed.data;
  const passwordHash = password
    ? await bcryptjs.hash(password, 12)
    : null;

  try {
    const admin = await prisma.admin.create({
      data: { email, passwordHash, role },
      select: {
        id: true,
        email: true,
        role: true,
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

// PUT /api/admin/admins/:id — Update admin
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

  try {
    const admin = await prisma.admin.update({
      where: { id },
      data: { isActive: parsed.data.isActive },
      select: {
        id: true,
        email: true,
        role: true,
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

// DELETE /api/admin/admins/:id — Delete admin
adminAdmins.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const currentAdmin = c.get("adminAuth");

  if (currentAdmin.adminId === id) {
    return c.json({ error: "Cannot delete yourself" }, 400);
  }

  // Prevent deleting last owner
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
