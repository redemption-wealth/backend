import { z } from "zod";

export const createAdminSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128).optional(),
  role: z.enum(["admin", "owner"]).default("admin"),
});

export const updateAdminSchema = z.object({
  isActive: z.boolean(),
});
