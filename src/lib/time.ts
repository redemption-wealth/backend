// WIB (Asia/Jakarta, UTC+7) helpers. Mirrors the toLocaleString pattern used
// elsewhere (e.g. routes/vouchers.ts) so calendar-day logic stays consistent.

const WIB_TZ = "Asia/Jakarta";
const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;

/** WIB calendar date as "YYYY-MM-DD" — used for daily quest period keys. */
export function wibDateString(now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  return now.toLocaleDateString("en-CA", { timeZone: WIB_TZ });
}

/** UTC instant of 00:00 WIB on the 1st of the current WIB month. */
export function wibMonthStartUtc(now: Date = new Date()): Date {
  const wibWallClock = new Date(now.toLocaleString("en-US", { timeZone: WIB_TZ }));
  wibWallClock.setDate(1);
  wibWallClock.setHours(0, 0, 0, 0);
  return new Date(wibWallClock.getTime() - WIB_OFFSET_MS);
}
