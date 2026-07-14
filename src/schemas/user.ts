import { z } from "zod";

// User-facing profile schemas (PATCH /api/users/me).

// Partial update: every field is optional so the app can PATCH one field at a
// time. `username` is normalised (trimmed) and restricted to a safe handle
// charset; uniqueness is enforced at the route/DB layer (409 on conflict).
export const updateProfileSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "Nama tidak boleh kosong")
      .max(80, "Nama maksimal 80 karakter"),
    username: z
      .string()
      .trim()
      .min(3, "Username minimal 3 karakter")
      .max(30, "Username maksimal 30 karakter")
      .regex(
        /^[a-zA-Z0-9_]+$/,
        "Username hanya boleh huruf, angka, dan garis bawah"
      ),
    phone: z.string().trim().min(1, "Nomor telepon tidak boleh kosong"),
    avatarUrl: z.string().trim().url("URL avatar tidak valid"),
  })
  .partial();

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
