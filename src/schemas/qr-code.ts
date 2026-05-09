import { z } from "zod";
import { paginationSchema } from "./common.js";

export const createQrCodeSchema = z.object({
  voucherId: z.string().cuid(),
  slotId: z.string().cuid(),
  qrNumber: z.number().int().min(1).max(2),
  imageUrl: z.string().url(),
  imageHash: z.string().min(1),
});

export const scanQrSchema = z.object({
  token: z.string().min(1),
});

export const qrCodeQuerySchema = paginationSchema.extend({
  voucherId: z.string().cuid().optional(),
  status: z.enum(["AVAILABLE", "REDEEMED", "USED"]).optional(),
});
