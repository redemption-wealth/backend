import { Hono } from "hono";
import bcryptjs from "bcryptjs";
import { prisma } from "../../db.js";
import { requireOwner, type AuthEnv } from "../../middleware/auth.js";

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
  const { email, password, role = "admin" } = await c.req.json();

  if (!email || !password) {
    return c.json({ error: "Email and password required" }, 400);
  }

  const passwordHash = await bcryptjs.hash(password, 12);

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
});

// PUT /api/admin/admins/:id — Update admin
adminAdmins.put("/:id", async (c) => {
  const id = c.req.param("id");
  const { isActive } = await c.req.json();

  const admin = await prisma.admin.update({
    where: { id },
    data: { isActive },
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
});

// DELETE /api/admin/admins/:id — Delete admin
adminAdmins.delete("/:id", async (c) => {
  const id = c.req.param("id");
  await prisma.admin.delete({ where: { id } });
  return c.json({ ok: true });
});

export default adminAdmins;
