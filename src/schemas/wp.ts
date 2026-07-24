import { z } from "zod";
import { getAddress, isAddress } from "viem";

// User-facing WP schemas.

// EVM address: 0x + 40 hex. Shared by WP→$WEALTH conversion and the CRYPTO
// reward campaign (payout wallet capture).
export const EVM_ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;

/**
 * Validate + normalize an EVM address to its EIP-55 checksummed form. `isAddress`
 * with `strict: true` accepts an all-lowercase / all-uppercase address (no
 * checksum to verify) or a correctly checksummed one, but REJECTS a mixed-case
 * address whose checksum is wrong — the EIP-55 typo guard the bare `0x + 40 hex`
 * regex misses. Manual $WEALTH payouts go to whatever we store, so we store the
 * canonical checksummed value. Throws on any invalid input.
 */
export function toChecksumAddress(value: string): string {
  const v = value.trim();
  if (!isAddress(v, { strict: true })) {
    throw new Error("Invalid EVM address");
  }
  return getAddress(v);
}

/** Zod EVM-address field: EIP-55 checksum-validated, normalized to checksummed. */
export const evmAddressSchema = z.string().transform((v, ctx) => {
  try {
    return toChecksumAddress(v);
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Alamat wallet tidak valid" });
    return z.NEVER;
  }
});

// POST /api/wp/convert — burn WP for $WEALTH. `toAddress` is EIP-55 validated and
// stored checksummed; the admin sends $WEALTH there manually.
export const convertWpSchema = z.object({
  wpAmount: z.coerce
    .number()
    .int()
    .positive("Jumlah WP harus lebih dari 0"),
  toAddress: evmAddressSchema,
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
