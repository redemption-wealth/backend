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
| 8 | `redemption_reliability.sql` | **Redemption reliability (anti-loss layers).** `redemptions.walletAddress` + `refundTxHash`/`refundedAt` (unique) + `slotId` → NULLABLE (failed attempts are now KEPT & detached, never deleted); enum `RedemptionStatus` += `REFUNDED`; new enum `UnmatchedTransferStatus` + table `unmatched_transfers` (**RLS enabled**) for the hybrid admin-review queue; index `app_users.walletAddress`. Idempotent. **Apply BEFORE deploying the webhook-fallback/sweep/refund backend code** (plan: `docs/redemption-reliability-plan.md`). | ✅ applied to REAL prod (`miycmnzhmeemfdbggolz`) via psql 2026-07-16 ~23:55 WIB — enum/table/columns verified |
| 9 | `recover_redemption_pgr_0x0b5f.sql` | **One-off DATA recovery (not a migration — do NOT re-apply).** Recreated redemption `recovery-0b5fc663-pgrvip` (user `rakasyaefudin9423@gmail.com`, PGR Tasikmalaya VIP): mainnet transfer 0.1509659771120788 $WEALTH succeeded (`0x0b5f...ad47`) but the app died before `submit-tx` and the stale sweep DELETED the PENDING row. Inserted as CONFIRMED; barcode assignment via `ensureQrAssigned` lazy-heal on first open. Root cause fixed by row 8 + the reliability code. | ✅ applied via SQL Editor 2026-07-16 (real prod project `miycmnzhmeemfdbggolz` — NOTE: local `.env`/`.env.bak.prod` point to a TEST project) |
| 10 | `recover_redemption_pgrvip_0x5c18.sql` | **One-off DATA recovery (not a migration — do NOT re-apply).** Recreated redemption `recovery-5c18b268-pgrvip` (user `ritanurhaeni@icloud.com`, PGR Tasikmalaya VIP): mainnet transfer 0.164100960789953904 $WEALTH succeeded (`0x5c18...9b17`, 2026-07-17 16:52:59 WIB) but Privy `sendTransaction` threw after broadcast → app believed nothing was sent → `POST /:id/cancel` DELETED the pending row; user retried 36s later (`0xf5f8`, recorded). 6 payments, 5 rows. Webhook fallback did NOT queue the orphan (`unmatched_transfers` empty for this hash) and `app_users.walletAddress` is NULL for this user → hybrid matcher blind. **Open fixes:** (1) cancel path must chain-check before delete; (2) `submit-tx` must not overwrite an already-set txHash; (3) backfill + sync `app_users.walletAddress`; (4) investigate why the webhook fallback never recorded the inflow. | ✅ applied via SQL Editor 2026-07-17 ~18:32 WIB (real prod; verified: row CONFIRMED, slot `0d4953c8` claimed, stock → 0; `createdAt` corrected to apply-time with a follow-up UPDATE — see file NOTE on the timestamp pitfall) |
| 11 | `backfill_app_user_wallets.sql` | **Backfill `app_users.walletAddress` from redemption history.** The app's `/api/auth/user-sync` never existed (silent 404) and the quests sync wiped stored wallets → most app_users have NULL wallet → the treasury-inflow matcher can't pair payments with users. Copies each user's latest redemption wallet; idempotent, only fills NULLs. **Apply together with** the deploy that adds the user-sync route + sync-preserve fix + app wallet sync (fix/redemption-cancel-reliability). ⚠️ **SUPERSEDED by the on-chain backfill** — `app_users` is EMPTY in prod, so this copies nothing. Use `scripts/backfill-wallets-onchain.ts` instead (derives `redemptions.walletAddress` from each CONFIRMED tx's on-chain `from`). | ⬜ NOT yet applied (use the on-chain script) |
| 12 | `add_inflow_sweep_heartbeat.sql` | **`app_settings.lastInflowSweepAt` (timestamptz, nullable).** Heartbeat set on every successful treasury-inflow sweep; `GET /api/cron/health` reports staleness (503 if > 30h) so an external uptime monitor can alert when the sweep silently stops (e.g. CRON_SECRET rotated → 401). Idempotent, additive. Ships with the round-2 reliability follow-up (PR #31). | ⬜ NOT yet applied |
| — | `scripts/backfill-wallets-onchain.ts` | **One-off on-chain wallet backfill (script, not SQL).** Fills `redemptions.walletAddress` NULLs from each CONFIRMED txHash's on-chain payer. Dry-run validated 2026-07-20 (21/22 resolve; rita → `0x1eb4…`). Run with **mainnet env** (`ETHEREUM_CHAIN_ID=1`, `WEALTH_CONTRACT_ADDRESS=0xafa702…`, a mainnet RPC) + `EXECUTE=true`. Idempotent, additive. | ⬜ NOT yet run |

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

### Pooler / connection audit (2026-07-16, after the password reset)
- **Config verdict: correct.** `db.ts` already releases connections aggressively
  (`idleTimeoutMillis: 500`, `allowExitOnIdle: true`, `max: 4`/instance, pool-error
  reset). No leak in normal operation; live census right after the incident showed the
  app holding 0 of 15 pooler slots.
- **Zombie sessions are a CREDENTIAL-ROTATION artifact only**: sessions opened before a
  password reset survive it and can exhaust the 15-slot session pool
  (EMAXCONNSESSION → 500s). **Runbook after every rotation:** run
  `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND usename='postgres' AND application_name != 'Supabase Studio';`
  in the SQL Editor, then redeploy the backend (env changes never apply to live
  deployments).
- **Burst math:** 15 slots ÷ max 4 = safe up to ~3 simultaneously-bursting instances.
  Cheap headroom when traffic grows: raise Supabase Pool Size 15 → 20-25 (Dashboard →
  Database → Connection Pooling). Follow-up idea: a DB-connections card in the
  back-office overview for visibility before saturation.

### Test accounts on the live DB (SECURITY)
`e2e-manager@wealth.local` + `e2e-owner@wealth.local` (password `E2ePassw0rd!`) were seeded
for testing and have been **deactivated** (`isActive=false`) + their sessions deleted.
`db:seed:e2e` re-activates the manager. **Delete both before real prod exposure** if this
Supabase is production.
