import { z } from "zod";
import { paginationSchema } from "./common.js";

export const createAdminSchema = z
  .object({
    email: z.string().email(),
    password: z.string().min(8).max(128).optional(),
    role: z.enum(["owner", "manager", "admin"]).default("manager"),
    merchantId: z.string().uuid().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.role === "admin" && !data.merchantId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "merchantId is required for admin role",
        path: ["merchantId"],
      });
    }
    if (data.role !== "admin" && data.merchantId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "merchantId is only allowed for admin role",
        path: ["merchantId"],
      });
    }
  });

export const updateAdminSchema = z.object({
  isActive: z.boolean().optional(),
  merchantId: z.string().uuid().nullable().optional(),
});

export const adminQuerySchema = paginationSchema.extend({
  role: z.enum(["owner", "manager", "admin"]).optional(),
  isActive: z.coerce.boolean().optional(),
  search: z.string().max(100).optional(),
});
