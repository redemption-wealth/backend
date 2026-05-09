import { z } from "zod";

export const signInSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(128),
});

const strongPassword = z
  .string()
  .min(8, "Minimal 8 karakter")
  .max(128)
  .regex(/[A-Z]/, "Harus mengandung huruf kapital")
  .regex(/[0-9]/, "Harus mengandung angka");

export const setupPasswordSchema = z
  .object({
    token: z.string().min(1),
    password: strongPassword,
    confirmPassword: z.string(),
  })
  .refine((d) => d.password === d.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1),
    newPassword: strongPassword,
    confirmPassword: z.string(),
  })
  .refine((d) => d.newPassword === d.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });
