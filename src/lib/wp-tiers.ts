// Loyalty tiers for AppUsers, derived from lifetime EARNED WP (the sum of all
// positive WpLedger amounts — earns only, never spends/clawbacks). Single source
// of truth for the thresholds so the back-office and any future surface agree.
//
// Thresholds (inclusive lower bound):
//   Gold   ≥ 100_000 earned WP
//   Silver ≥  25_000 earned WP
//   Bronze  everything else (the default / entry tier)

export type WpTier = "Bronze" | "Silver" | "Gold";

export const WP_TIER_THRESHOLDS = {
  Gold: 100_000,
  Silver: 25_000,
  Bronze: 0,
} as const;

/** Map a lifetime-earned-WP total to its loyalty tier. */
export function deriveTier(totalEarnedWp: number): WpTier {
  if (totalEarnedWp >= WP_TIER_THRESHOLDS.Gold) return "Gold";
  if (totalEarnedWp >= WP_TIER_THRESHOLDS.Silver) return "Silver";
  return "Bronze";
}
