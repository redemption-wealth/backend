import { z } from "zod";
import { paginationSchema } from "./common.js";

export const createQrCodeSchema = z.object({
  voucherId: z.string().uuid(),
  imageUrl: z.string().url(),
  imageHash: z.string().min(1),
});

export const qrCodeQuerySchema = paginationSchema.extend({
  voucherId: z.string().uuid().optional(),
  status: z.enum(["available", "assigned", "used"]).optional(),
});
