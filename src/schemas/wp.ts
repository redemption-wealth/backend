import { z } from "zod";

// User-facing WP schemas.

// EVM address: 0x + 40 hex. Shared by WP→$WEALTH conversion and the CRYPTO
// reward campaign (payout wallet capture).
export const EVM_ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;

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
    .regex(EVM_ADDRESS_REGEX, "Alamat wallet tidak valid"),
});

// POST /api/rewards/:id/redeem — optional fulfilment payload. All fields are
// optional at the transport layer; which ones are REQUIRED depends on the
// reward category and is enforced in redeemReward (domain errors → 400):
//   MERCH / SEMBAKO → recipientName + recipientPhone + shippingAddress
//   CRYPTO          → a valid EVM walletAddress
// Fields not relevant to the reward's category are ignored.
export const redeemRewardSchema = z.object({
  recipientName: z.string().trim().max(200).optional(),
  recipientPhone: z.string().trim().max(50).optional(),
  shippingAddress: z.string().trim().max(1000).optional(),
  walletAddress: z.string().trim().max(64).optional(),
});

export type RedeemRewardInput = z.infer<typeof redeemRewardSchema>;
