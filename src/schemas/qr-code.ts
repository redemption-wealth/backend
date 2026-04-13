import { z } from "zod";
import { paginationSchema } from "./common.js";

export const createQrCodeSchema = z.object({
  voucherId: z.string().uuid(),
  token: z.string().min(1),
  imageUrl: z.string().url().optional(),
  imageHash: z.string().min(1).optional(),
});

export const scanQrSchema = z.object({
  token: z.string().min(1),
});

export const qrCodeQuerySchema = paginationSchema.extend({
  voucherId: z.string().uuid().optional(),
  status: z.enum(["available", "assigned", "used"]).optional(),
});
