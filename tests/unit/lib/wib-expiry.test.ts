import { describe, it, expect } from "vitest";
import { isWibDayExpired } from "@/lib/time.js";

/**
 * M3: a date-boxed reward/voucher is valid through the END of its WIB day
 * (23:59:59.999 WIB = 16:59:59.999 UTC), not from 07:00 WIB when a date-only
 * expiry (stored at 00:00 UTC) would naively compare as already past.
 */
describe("isWibDayExpired (end-of-day WIB)", () => {
  // Admin picks 2026-07-24 → stored at midnight UTC = 07:00 WIB the same day.
  const expiry = new Date("2026-07-24T00:00:00.000Z");

  it("is NOT expired during the WIB expiry day (the M3 bug it fixes)", () => {
    // 15:00 UTC = 22:00 WIB on 2026-07-24 — still the expiry day.
    expect(isWibDayExpired(expiry, new Date("2026-07-24T15:00:00Z"))).toBe(false);
    // 07:01 WIB (00:01 UTC): the OLD getTime()<Date.now() check called this
    // expired ~17h early; end-of-day WIB keeps it valid.
    expect(isWibDayExpired(expiry, new Date("2026-07-24T00:01:00Z"))).toBe(false);
  });

  it("is NOT expired at the last WIB moment, expired just after", () => {
    // 16:59:59.999 UTC = 23:59:59.999 WIB — the final valid instant.
    expect(isWibDayExpired(expiry, new Date("2026-07-24T16:59:59.999Z"))).toBe(false);
    // 17:00:00 UTC = 00:00 WIB on 2026-07-25 — now expired.
    expect(isWibDayExpired(expiry, new Date("2026-07-24T17:00:00.000Z"))).toBe(true);
  });

  it("is expired on any later WIB day", () => {
    expect(isWibDayExpired(expiry, new Date("2026-07-25T09:00:00Z"))).toBe(true);
  });
});
