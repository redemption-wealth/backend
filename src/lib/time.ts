// WIB (Asia/Jakarta, UTC+7) helpers. Mirrors the toLocaleString pattern used
// elsewhere (e.g. routes/vouchers.ts) so calendar-day logic stays consistent.

const WIB_TZ = "Asia/Jakarta";
const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;

/** WIB calendar date as "YYYY-MM-DD" — used for daily quest period keys. */
export function wibDateString(now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  return now.toLocaleDateString("en-CA", { timeZone: WIB_TZ });
}

/**
 * True once a date-boxed campaign window (reward/voucher expiry) has fully
 * passed. Such a window is valid through the END of its WIB day, per the M3
 * rule — 23:59:59.999 WIB == 16:59:59.999 UTC. Mirrors the app's isVoucherExpired
 * so backend and client agree. Admins pick a date-only expiry (stored at 00:00
 * UTC = 07:00 WIB the same calendar day), so without this an expiry would kick in
 * ~17h early at 07:00 WIB instead of end-of-day.
 */
export function isWibDayExpired(
  expiresAt: Date,
  now: Date = new Date()
): boolean {
  const end = new Date(expiresAt);
  end.setUTCHours(16, 59, 59, 999); // end of the expiry's WIB day
  return end < now;
}

/** UTC instant of 00:00 WIB on the 1st of the current WIB month. */
export function wibMonthStartUtc(now: Date = new Date()): Date {
  const wibWallClock = new Date(now.toLocaleString("en-US", { timeZone: WIB_TZ }));
  wibWallClock.setDate(1);
  wibWallClock.setHours(0, 0, 0, 0);
  return new Date(wibWallClock.getTime() - WIB_OFFSET_MS);
}
