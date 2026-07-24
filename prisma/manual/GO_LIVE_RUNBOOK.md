# Go-Live Runbook — Backend + Back-office (first production deploy)

Companion to `PROD_ROLLOUT_CHECKLIST.md` (which tracks individual SQL/code changes).
This file is the **end-to-end sequence** to take backend + back-office live for the
first time. The user-facing **app is a later, separate rollout** — not covered here.

Derived from the 2026-07-14 production-readiness audit (backend + back-office).
Severity tags: 🔴 blocker · 🟠 must-do · 🟡 should-do · 🟢 nice-to-have.

---

## 0. Decisions (RESOLVED 2026-07-14)

| # | Decision | Resolution |
|---|----------|------------|
| D1 | Fresh prod DB vs promote dev? | **Existing live prod Supabase DB already exists** (separate from dev). This is an **UPDATE to a running production system**, not greenfield. Just apply the missing SQL — see §2. |
| D2 | Mainnet real-money vs soft-launch? | **Mainnet, real-money now.** All payment blockers must clear: chain→mainnet, `DEMO_INSTANT_CONFIRM` gated+off, mainnet Alchemy webhook, real treasury. Smoke-test one real redemption before announcing. |

Still to confirm (not forks, just values needed): D3 prod domains for `CORS_ORIGINS`,
D4 whether prod uses a separate Privy app, D5 the R2 custom CDN domain (`pub-*.r2.dev`
is blocked by some Indonesian ISPs → logos/covers won't load).

---

## 1. Pre-flight CODE changes (do on `dev`, then merge → `main`)

These ship with the deploy; make them before cutting the release.

### Backend
- 🔴 **Gate `DEMO_INSTANT_CONFIRM`** — `src/routes/redemptions.ts:261`. Add
  `&& process.env.NODE_ENV !== "production"` so it can NEVER confirm a redemption
  without on-chain payment in prod, even if the env var leaks in. (`DEV_AUTH_BYPASS`
  is already gated this way — mirror it.)
- 🔴 **Datasource URL for the Prisma CLI** — `prisma/schema.prisma` `datasource db`
  block has no `url`. The runtime uses the PrismaPg adapter, but `migrate deploy`
  needs one. Add `url = env("DATABASE_URL")` (and `directUrl` if using it) so §2
  can run. Verify `prisma generate` + runtime still work after.
- 🟠 **`vercel.json` region + duration** — add `"regions": ["icn1"]` (Seoul, co-located
  with the Supabase DB in `ap-northeast-2`; otherwise every query pays ~180ms US↔Seoul)
  and `"functions": { "api/index.ts": { "maxDuration": 30 } }` (default 10s risks 504s
  on cold `$transaction` START ~6.7s).
- 🟡 Consider moving rate limiting to a shared store (Upstash) later — in-memory is
  ineffective across serverless instances. Not a launch blocker (login still needs a
  valid bcrypt password).

### Back-office
- 🔴 **API base URL must fail loud, not default to localhost** — `src/lib/api/client.ts:4`
  falls back to `http://localhost:3001` if `VITE_API_BASE_URL` is unset at build time.
  Since Vite inlines env at build, a missing var silently ships a broken prod bundle.
  Either remove the fallback (throw if unset) or at minimum guarantee the Vercel env is
  set (§3). Note the URL must include the `/api` suffix.
- 🟠 **Add CSP + security headers** in `vercel.json` (`headers` block: CSP,
  `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, HSTS). CLAUDE.md claims the
  localStorage-JWT XSS risk is "mitigated by CSP" — but no CSP exists yet. Self-host or
  allowlist the Google Fonts (`fonts.googleapis.com`) used in `index.html` when you do.
- 🟡 `git rm --cached .env.local.prodbak` and tighten `.gitignore` to `.env.*` (stray
  committed file; non-secret but shouldn't ship).
- 🟡 Route the ~7 WP pages' `Gagal memuat: {error.message}` through
  `getApiErrorMessage()` for localized, non-raw errors.

---

## 2. Bring the EXISTING prod DB up to date (D1 = existing live DB)

Prod DB already has the base schema (backend has been live). Only the NEW manual SQL
from this dev cycle needs applying — WP/quest tables, conversions, profile cols, fraud
enum, merchant category→text, voucher coverImageUrl. Vercel does NOT run migrations, so
apply these BY HAND **before** deploying the new backend code.

**Step 1 — check current state (read-only).** Run `prisma/manual/_prod_state_check.sql`
in the prod Supabase SQL Editor. It returns one row per change with `OK (present)` or
`❌ MISSING`. Apply only the MISSING ones.

**Step 2 — apply the missing files, in file order 1→7** (`psql "$PROD_DATABASE_URL" -f
prisma/manual/<file>.sql`, or paste into SQL Editor):

| # | File | Idempotent? |
|---|------|-------------|
| 1 | `wp_quests.sql` | ⚠️ **NO** — bare `CREATE TABLE`. Run ONLY if the state-check shows `app_users table` MISSING (it will error if WP tables already exist). |
| 2 | `wp_lengkap_wave1.sql` | ✅ yes |
| 3 | `wp_conversion_wave2.sql` | ✅ yes |
| 4 | `wp_profile_devbypass_wave3.sql` | ✅ yes |
| 5 | `wp_backoffice_gaps_wave4.sql` | ✅ yes |
| 6 | `fix_merchant_category_to_text.sql` | ✅ yes (text→text recast is a no-op) |
| 7 | `add_voucher_cover_image.sql` | ✅ yes |

**Step 3 — take a Supabase snapshot/backup FIRST** (before applying anything). No
down-migrations exist.

**Step 4 — re-run the state-check** — every row should read `OK (present)`. Then update
the "Prod applied?" column in `PROD_ROLLOUT_CHECKLIST.md`.

> Because this DB was never a test playground, there should be no `e2e-*` admins to
> purge — but confirm via the state-check era: run
> `SELECT email FROM public.users WHERE email LIKE 'e2e-%' OR email LIKE '%@wealth.local';`
> and delete any hits + their sessions before go-live. Never run `db:seed:e2e` on prod.

---

## 3. Secrets & Vercel env vars (all FRESH for prod — never reuse dev)

Rotate/replace everything; the dev `.env` holds live *dev* creds in plaintext.

### Backend (Vercel → backend project → Environment Variables, Production)
| Var | Value for prod |
|-----|----------------|
| `DATABASE_URL` | prod Supabase pooler string (§2) |
| `BETTER_AUTH_SECRET` | **new** strong 32+ char random (not the dev `local-dev-…` string) |
| `BETTER_AUTH_URL` | prod backend URL |
| `CORS_ORIGINS` | prod back-office domain (+ app domain later), comma-separated |
| `PRIVY_APP_ID` / `PRIVY_APP_SECRET` | prod Privy app (D4) |
| `CRON_SECRET` | **new** strong random — else both crons 401 forever (stale PENDING redemptions never release stock) |
| `ETHEREUM_CHAIN_ID` | `1` (mainnet) — **not** `11155111` — if D2 = real launch |
| `WEALTH_CONTRACT_ADDRESS` | mainnet `0xafa702c0A2a3a0Cf1bD09435DB61C913cCDe8546` |
| `ALCHEMY_RPC_URL` | mainnet Alchemy endpoint |
| `ALCHEMY_WEBHOOK_SIGNING_KEY` | signing key of the **newly-created mainnet** webhook (§4) |
| `DEV_WALLET_ADDRESS` | real prod **treasury** address (var is misnamed) |
| `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | prod R2 creds |
| `R2_LOGO_PUBLIC_URL` | **custom CDN domain** (D5), not `pub-*.r2.dev` |
| `R2_QR_BUCKET_NAME` / `R2_LOGO_BUCKET_NAME` | prod bucket names |
| `CMC_API_KEY` / `WEALTH_CMC_SLUG` | prod CMC key / slug |
| `INITIAL_OWNER_EMAIL` | real owner email (used by seed) |
| ~~`DEMO_INSTANT_CONFIRM`~~ | **DO NOT SET** |
| ~~`DEV_AUTH_BYPASS`~~ | **DO NOT SET** |

### Back-office (Vercel → back-office project, Production — inlined at BUILD time)
| Var | Value |
|-----|-------|
| `VITE_API_BASE_URL` | prod backend URL **with `/api` suffix** |
| `VITE_NETWORK` | `mainnet` (invalid value white-screens the app at load) |

---

## 4. External services

- **Privy (D4)**: create/point the prod app; set allowed login methods + origins to the
  prod domains.
- **Alchemy (if D2 = mainnet)**: create a mainnet app; **re-create the Address Activity
  webhook** targeting the prod backend webhook URL and watching the prod treasury; copy
  its new signing key into `ALCHEMY_WEBHOOK_SIGNING_KEY`. (Testnet webhook won't fire for
  mainnet transfers.)
- **R2 (D5)**: map the custom CDN domain to the logo/cover bucket; set `R2_LOGO_PUBLIC_URL`.

---

## 5. Deploy sequence

1. Merge `dev` → `main` (both repos) once §1 changes are in. Confirm each Vercel project's
   Git connection is live (known gotcha: stale connection = 0 commit status, no auto-deploy;
   reconnect in Settings → Git).
2. **Deploy backend first.** Wait for green. Smoke-test §6.1.
3. **Deploy back-office second** (needs the backend URL already live). Smoke-test §6.2.
4. Trigger the owner setup-password link (seed created the owner with NULL password) and
   set the real password. Then create the real Manager/Admin accounts + merchants through
   the UI.

---

## 6. Post-deploy smoke test (do on PROD, before announcing)

### 6.1 Backend
- `GET /api/health` (or root) 200.
- Owner login returns a session/bearer.
- Cron auth: hitting a cron route without the bearer → 401; with it → 200.
- Upload path works (create a merchant with a logo → image resolves from the CDN domain).

### 6.2 Back-office
- Loads over `https://` with no mixed-content/CORS errors (confirms `VITE_API_BASE_URL`
  + `CORS_ORIGINS` are right — the #1 first-deploy failure).
- Login as owner → owner routes. Create a manager → login as manager → `/admin` routes.
- Create a merchant + a voucher (with cover image) → appears in list, detail page renders.
- QR monitor / counts load (no 500 from the status filter).
- WP → Users → Detail opens; adjust WP works.

### 6.3 Payment integrity (if D2 = mainnet)
- Confirm `DEMO_INSTANT_CONFIRM` is unset: a redemption stays PENDING until a **real**
  on-chain transfer is observed by the webhook. Do one tiny real redemption end-to-end
  and verify the webhook confirms it and stock decrements.

---

## 7. Rollback

- Vercel: instant "Promote previous deployment" per project.
- DB: manual SQL files are idempotent, but there is **no down-migration**. Take a Supabase
  snapshot/backup immediately before §2 and before any future manual SQL, so you can
  restore. Never run a destructive change without a fresh backup.

---

## 8. Monitor (first 48h)

- **Supabase pooler connection count** — pool `max:4` × N serverless instances vs the
  ~15-connection ceiling. If you see `connection-timeout` 500s, drop `max` to 2–3.
- Function duration / 504s (cold `$transaction` START).
- Webhook delivery success (Alchemy dashboard) — a silent webhook failure = redemptions
  stuck PENDING.
- Cron runs firing on schedule (expire-pending 02:00 WIB, wp-daily 00:05 WIB).
- Error rate in Vercel logs.

---

## Top blockers recap (must clear before real prod)

1. 🔴 Gate `DEMO_INSTANT_CONFIRM` in code + never set it in Vercel (free vouchers otherwise).
2. 🔴 Switch chain config Sepolia → mainnet (contract/RPC/webhook/treasury) — if D2 = real launch.
3. 🔴 Fresh-prod-DB provisioning: datasource `url` fix → `migrate deploy` → 7 manual SQL → verify diff → seed owner.
4. 🔴 Back-office `VITE_API_BASE_URL` (+`/api`) + `VITE_NETWORK=mainnet` set at Vercel build.
5. 🟠 Rotate ALL secrets; purge/never-seed the `e2e-*` test admins.
6. 🟠 Set every required backend Vercel env (`CORS_ORIGINS`, `CRON_SECRET`, Privy, Alchemy webhook key, R2 + CDN URL).
7. 🟠 `vercel.json`: `regions:["icn1"]` + `maxDuration`; back-office CSP/security headers.
</content>
</invoke>
