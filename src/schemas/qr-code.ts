import { z } from "zod";
import { paginationSchema } from "./common.js";

// DEPRECATED: QR codes are now auto-generated with vouchers via slots
export const createQrCodeSchema = z.object({
  voucherId: z.string().uuid(),
  slotId: z.string().uuid(),
  qrNumber: z.number().int().min(1).max(2),
  imageUrl: z.string().url(),
  imageHash: z.string().min(1),
});

export const scanQrSchema = z.object({
  id: z.string().uuid().optional(),
  token: z.string().min(1).optional(), // TODO: remove after Phase 2
}).refine((data) => data.id || data.token, {
  message: "Either id or token must be provided",
});

export const qrCodeQuerySchema = paginationSchema.extend({
  voucherId: z.string().uuid().optional(),
  status: z.enum(["available", "redeemed", "used"]).optional(),
});
