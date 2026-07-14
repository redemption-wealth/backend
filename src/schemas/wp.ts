import { z } from "zod";

// User-facing WP schemas.

// POST /api/wp/convert — burn WP for $WEALTH. `toAddress` is validated loosely
// as an EVM address (0x + 40 hex); the admin sends $WEALTH there manually.
export const convertWpSchema = z.object({
  wpAmount: z.coerce
    .number()
    .int()
    .positive("Jumlah WP harus lebih dari 0"),
  toAddress: z
    .string()
    .trim()
    .regex(/^0x[a-fA-F0-9]{40}$/, "Alamat wallet tidak valid"),
});
