# Production Rollout Checklist — Manual DB & Code Changes

Migrations are **manual** (Vercel does NOT run `prisma migrate deploy`). Every schema/
data change must be applied to the production Supabase DB **before** deploying code that
depends on it. This file is the single source of truth — **append every future
query/SQL change here** so nothing is missed at prod rollout.

Prisma columns are camelCase & unmapped → **quote them in raw SQL** (`"deletedAt"`).

---

## SQL migrations (apply in order)

| # | File | What it does | Applied to Supabase? |
|---|------|--------------|----------------------|
| 1 | `wp_quests.sql` | Base WEALTH Points / Quest tables (quests, rewards, ledger, redemptions, etc.) | ✅ yes |
| 2 | `wp_lengkap_wave1.sql` | WP wave 1 — fulfillment note column + gaps | ✅ yes |
| 3 | `wp_conversion_wave2.sql` | WpConversion table + AppSettings conversion columns + ledger types | ✅ yes |
| 4 | `wp_profile_devbypass_wave3.sql` | AppUser profile columns (name/username/phone/avatarUrl) + username unique index | ✅ yes |
| 5 | `wp_backoffice_gaps_wave4.sql` | `fraudReviewStatus` enum + column on app users | ✅ yes |
| 6 | `fix_merchant_category_to_text.sql` | **`merchants.category` ENUM → text.** Legacy Postgres enum `MerchantCategory` rejected the app's free-form labels ("Sport & Fitness", …) → create/edit merchant returned 500. Idempotent. | ✅ applied 2026-07-12 |
| 7 | `add_voucher_cover_image.sql` | **`vouchers.coverImageUrl` (text, nullable).** Merchant-uploaded cover photo shown full-bleed as the voucher hero (falls back to merchant logo → monogram). Idempotent, no backfill. Ships with voucher create/update code that reads/writes it. | ✅ applied to dev 2026-07-13 |

To apply a file:
```bash
psql "$DATABASE_URL" -f prisma/manual/<file>.sql
# or paste into Supabase SQL Editor
```

---

## Code changes that MUST ship with a deploy (not SQL, but prod-critical)

| Date | File | Change | Why |
|------|------|--------|-----|
| 2026-07-12 | `src/db.ts` | Added `transactionOptions: { maxWait: 15_000, timeout: 20_000 }` to `PrismaClient`. | Interactive `$transaction` (admin create = user+account+admin+token) must hold the single pooled connection (`max: 1`). Against the Supabase PgBouncer pooler a cold START exceeds Prisma's default `maxWait` (2s) → **P2028** → **admin create 500**. Verified: tx START takes ~6.7s on the pooler. Applies to prod (Vercel serverless uses the same pooler + `max:1`). |
| 2026-07-13 | `src/db.ts` | Pool `max: 1 → 4`, `connectionTimeoutMillis: 10s → 20s`. | A dashboard load fires ~10 analytics requests at once; with `max:1` they serialised and the tail queued past the 10s connection timeout → **connection-timeout 500s under burst** (measured 14/15 concurrent failing, 43s). With `max:4` the burst runs in parallel → **0/15 fail, ~6s**. **Prod note:** each serverless instance can now hold up to 4 pooler connections (was 1). Kept modest so N concurrent instances stay under the Supabase pooler's ~15-connection ceiling; `idleTimeoutMillis:500` still releases each connection right after the burst. Monitor pooler connection count after deploy. |

---

## Verified live (2026-07-12) — API + browser e2e against Supabase

Comprehensive API CRUD suite: **47/47 PASS** (merchants, vouchers, admins, settings,
analytics ×9, QR, WP, auth positive/negative/edge). Real-Chromium walkthrough of every
back-office page + a full merchant-create through the UI ("Merchant berhasil ditambahkan").

Two bugs found & fixed this pass: **merchant-create 500** (row 6 above) and
**admin-create 500** (db.ts row above).

### Known follow-ups (not blockers)
- **WP Ringkasan slow first-load — ANALYZED 2026-07-12: do NOT change the pool.**
  Measured facts: the WP-overview API endpoint alone is ~1.5-2s (6 queries in `Promise.all`).
  The dashboard fires **8 parallel analytics calls**, each also paying 2 auth queries in
  `requireAdmin`. Locally there is ONE backend process with `max:1`, so that flood
  serializes → navigating to WP while the dashboard's calls are still draining took ~18s;
  warm re-nav is ~121ms (React Query cache). Bumping `max` to 5 locally cut it to ~7.5s
  (confirms the cause is `max:1` serialization).
  **Why not change it:** the 18s is largely a LOCAL single-process artifact. On Vercel,
  concurrent requests fan out across multiple serverless instances (each its own `max:1`
  pool) → natural parallelism, so prod ≈ per-endpoint latency, not 18s. Raising `max` risks
  the Supabase 15-connection ceiling under serverless concurrency (N instances × max). The
  `max:1` + `idleTimeoutMillis:500` config is a deliberate serverless-safety choice.
  **If cold-load ever needs improving, the SAFE lever is server-side caching** of the
  overview/analytics endpoints (data changes slowly) — NOT the pool. Users feel: first cold
  visit a few seconds (with skeletons), subsequent nav instant.
- Playwright e2e specs (`back-office/e2e/*.spec.ts`) are **stale** vs the WP redesign
  (Konversi now "Segera"/coming-soon, WP card labels changed, overview 10s timeout too
  tight). Update selectors — app behavior is correct, the assertions are old.
- Frontend requires `category` on merchant create; backend treats it as optional. Minor
  inconsistency (frontend stricter) — align if desired.

### Test accounts on the live DB (SECURITY)
`e2e-manager@wealth.local` + `e2e-owner@wealth.local` (password `E2ePassw0rd!`) were seeded
for testing and have been **deactivated** (`isActive=false`) + their sessions deleted.
`db:seed:e2e` re-activates the manager. **Delete both before real prod exposure** if this
Supabase is production.
