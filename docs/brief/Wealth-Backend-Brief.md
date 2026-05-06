# Wealth Redemption Backend — Refactor Brief

**Status:** Locked, ready for implementation
**Date:** 2026-05-04
**Stack target:** Hono + Better Auth + Prisma + Postgres + viem + R2 + Vercel serverless

---

## 1. Auth

### Library & Strategy
- **Library:** Better Auth (Hono adapter)
- **Session:** Database session (table `sessions` di Postgres, managed by Better Auth)
- **Multi-device:** Allowed (1 user banyak session, beda device beda row)
- **Email service:** **Tidak ada.** Reset manual via Owner.
- **Rate limit:** In-memory (existing pattern, low-traffic backoffice acceptable)

### Schema (fresh start, no data migration)

```
users (Better Auth managed)
  - id (uuid)
  - email (unique)
  - password (bcrypt hash, nullable saat reset/account baru)
  - emailVerified (default true, no email service)
  - createdAt, updatedAt

admins (custom extension, 1-to-1 dengan users)
  - id (uuid)
  - userId → users.id (FK unique)
  - role (enum: owner | manager | admin)
  - merchantId → merchants.id (nullable, mandatory cuma untuk role=admin)
  - isActive (boolean, default true)
  - lastLoginAt (timestamp, untuk audit)
  - createdAt, updatedAt

sessions (Better Auth managed)
  - id (uuid)
  - userId → users.id
  - token (random)
  - expiresAt
  - ipAddress, userAgent
  - createdAt, updatedAt

password_setup_tokens (custom)
  - id (uuid)
  - userId → users.id
  - token (random 32-byte)
  - expiresAt (5 menit)
  - usedAt (nullable, mark when consumed)
  - createdAt
```

### Logic Rules

- **Pending Setup detection:** `users.password IS NULL` → backend return `{ pendingSetup: true }` di response list admin. Cover dua kasus: account baru dan post-reset.
- **Reset password (Owner action):**
  - Set `users.password = NULL`
  - Delete semua row di `sessions WHERE userId = X` (auto-logout admin tsb)
  - Return 200
- **Set password (admin action via temp token):**
  - Consume `password_setup_tokens` row (validate not expired, not used)
  - Set `users.password = bcrypt(newPassword)`
  - Mark token used
  - Issue session (auto-login)
- **Change password (admin action):**
  - Verify current password
  - Update `users.password = bcrypt(newPassword)`
  - Delete semua sessions kecuali current (`DELETE FROM sessions WHERE userId = X AND id != currentSessionId`)
- **Login flow:**
  - Email + password → Better Auth verify → issue session
  - Kalau `password IS NULL` → backend return `{ needsPasswordSetup: true, setupToken: "..." }` (issue temp token)
- **Self-protection (Owner):**
  - Tidak bisa delete diri sendiri
  - Tidak bisa deactivate diri sendiri
  - Tidak bisa change role diri sendiri
  - Tidak bisa delete last owner

### Authorization (Custom)

Better Auth handle authentication doang. Authorization tetep custom:
- **Middleware:** `requireAuth`, `requireOwner`, `requireManager`, `requireAdmin` (any logged-in admin)
- **Handler-level:** merchant scoping (untuk role admin) — context-dependent, susah di-middleware

---

## 2. Endpoints

### Auth (Better Auth + custom)

| Method | Path | Purpose | Source |
|--------|------|---------|--------|
| POST | `/auth/sign-in/email` | Login (email + password) | Better Auth |
| POST | `/auth/sign-out` | Logout current session | Better Auth |
| GET | `/auth/get-session` | Current session info | Better Auth |
| POST | `/auth/setup-password` | Set password via temp token | Custom |
| POST | `/auth/change-password` | Change password (3-input) | Custom |
| POST | `/auth/sign-out-others` | Logout other devices | Custom |

### Owner Endpoints

**Dashboard Analytics:**

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/admin/analytics/summary` | KPI cards |
| GET | `/admin/analytics/treasury-balance` | On-chain balance read (cache 60s) |
| GET | `/admin/analytics/redemptions-over-time?period=daily\|monthly\|yearly` | Line chart data, format `[{date, count}]` |
| GET | `/admin/analytics/wealth-volume?period=monthly` | Bar chart data |
| GET | `/admin/analytics/merchant-categories` | Pie chart data |
| GET | `/admin/analytics/top-merchants?limit=N` | Leaderboard (Prisma groupBy) |
| GET | `/admin/analytics/top-vouchers?limit=N` | Leaderboard (Prisma groupBy) |
| GET | `/admin/redemptions/recent?limit=10` | Activity feed |

**Account Management:**

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/admin/admins` | List with filter (role, status, email, pendingSetup) |
| POST | `/admin/admins` | Create admin (validate email unique, merchantId mandatory if role=admin) |
| GET | `/admin/admins/:id` | Detail |
| PUT | `/admin/admins/:id` | Update (role, merchantId, isActive) |
| DELETE | `/admin/admins/:id` | Delete (with self-protection guards) |
| POST | `/admin/admins/:id/reset-password` | Reset (set password NULL + delete sessions) |
| POST | `/admin/admins/:id/toggle-active` | Toggle aktif/nonaktif |

**Activity Log:**

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/admin/redemptions` | List with filter (status, date range, search by txHash/email) |
| GET | `/admin/redemptions/counts` | `{ all, confirmed, pending, failed }` (replace 5 calls) |
| GET | `/admin/redemptions/:id` | Detail |

### Manager Endpoints

**Overview:**

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/admin/overview` | `{ totalMerchants, totalVouchers, totalQrAvailable }` |

**Merchants:**

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/admin/merchants` | List with filter (search, category, isActive, default sembunyikan soft-deleted) |
| POST | `/admin/merchants` | Create |
| GET | `/admin/merchants/:id` | Detail (info merchant only, voucher fetch via separate endpoint) |
| PUT | `/admin/merchants/:id` | Update |
| DELETE | `/admin/merchants/:id` | Soft delete (set deletedAt) |
| POST | `/admin/merchants/:id/toggle-active` | Toggle |
| POST | `/admin/upload/logo` | Logo upload (max 2MB, PNG/WebP/JPEG, ke R2) |
| GET | `/admin/categories` | Static enum list (kuliner, hiburan, event, kesehatan, lifestyle, lainnya) |

**Vouchers:**

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/admin/vouchers` | List with filter (search, merchantId, isActive, status: expired/active/upcoming) |
| POST | `/admin/vouchers` | Create (with slot + QR scaffolding) |
| GET | `/admin/vouchers/:id` | Detail |
| PUT | `/admin/vouchers/:id` | Update (Zod `.strict()`, field whitelist enforce) |
| DELETE | `/admin/vouchers/:id` | Soft delete (validate no QR REDEEMED/USED) |
| POST | `/admin/vouchers/:id/toggle-active` | Toggle |

**QR Monitoring:**

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/admin/qr-codes` | List with filter (status, merchantId, voucherId) |
| GET | `/admin/qr-codes/counts` | `{ available, redeemed, used }` (replace 3 calls) |

**System Config:**

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/admin/settings` | `{ appFeeRate, gasFeeAmount }` |
| PUT | `/admin/settings` | Update keduanya atau salah satu |

### Admin Endpoints

Admin re-use Manager endpoint, dengan **merchant scoping di handler-level**:

| Method | Path | Scope |
|--------|------|-------|
| GET | `/admin/merchants/:id` | Hanya kalau `:id === admin.merchantId`, else 404 |
| POST | `/admin/vouchers` | Body `merchantId` harus match `admin.merchantId`, else 403 |
| PUT | `/admin/vouchers/:id` | Voucher.merchantId match, else 404 |
| DELETE | `/admin/vouchers/:id` | Voucher.merchantId match, else 404 |
| POST | `/admin/vouchers/:id/toggle-active` | Same scope check |
| POST | `/admin/qr-codes/scan` | QR.voucher.merchantId match, else 404 |

Endpoint **tidak** boleh diakses Admin: merchant CRUD, vouchers list cross-merchant, QR Monitoring, account mgmt, activity log, system config.

### Public/External

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/price/wealth` | WEALTH price IDR (CMC + FX, cache 60s + 15min) |
| POST | `/vouchers/:id/redeem` | User initiate redemption (validate price server-side, no client-supplied price) |
| PATCH | `/redemptions/:id/submit-tx` | User submit txHash post-signing |
| GET | `/redemptions/:id` | User check redemption status (auto-reconcile lazy after 30s) |
| POST | `/webhook/alchemy` | Alchemy webhook (HMAC verify, fast confirmation path) |

---

## 3. Business Logic Rules

### Voucher Edit Constraints

| Field | Editable | Notes |
|-------|----------|-------|
| title, description | Yes | |
| startDate, expiryDate | Yes | |
| isActive | Yes | |
| totalStock | Yes | Floor = COUNT slot REDEEMED + FULLY_USED. Naik: generate slot + QR baru. Turun: hapus slot AVAILABLE dari belakang |
| basePrice | **No** | Reject 422 via Zod `.strict()` |
| qrPerSlot | **No** | Reject 422 |
| feeSnapshot | **No** | Reject 422 |

Field whitelist enforce di Zod schema (defense in depth — bukan cuma di FE).

### Voucher Snapshot

Saat voucher created, snapshot:
- `appFeeSnapshot` ← current `app_settings.appFeeRate`
- `gasFeeSnapshot` ← current `app_settings.gasFeeAmount`

Voucher lama tetep pakai snapshot lama saat redemption. Manager ganti settings = voucher baru pakai nilai baru.

### Redemption Flow

1. User initiate `POST /vouchers/:id/redeem`:
   - Backend fetch server-side cached price (CMC). **Reject client-supplied price**.
   - Calculate wealthAmount based on server-side price + voucher snapshot
   - Issue idempotency check
   - Generate slot + QR (atomic transaction)
   - Return txDetails (contract address from env, treasury address from env)
2. User sign transfer on-chain (FE responsibility)
3. User `PATCH /redemptions/:id/submit-tx` with txHash
4. Confirmation:
   - **Primary:** Alchemy webhook → HMAC verify → confirm
   - **Fallback:** Auto-reconcile via `getTransactionReceipt` saat FE poll, lazy trigger (only kalau pending > 30 detik)
5. On confirm: decrement `voucher.remainingStock` (single source — drop double-decrement bug)

### QR Scan Flow (Admin)

1. Admin POST `/admin/qr-codes/scan` body `{ id: uuid }`
2. Backend lookup QR → check QR.voucher.merchantId === admin.merchantId (else 404)
3. Status check:
   - AVAILABLE → 422 (user belum redeem)
   - USED → 409 (sudah dipakai)
   - REDEEMED → mark as USED + check kalau slot fully used
4. Stock decrement DROP dari sini (already di confirmRedemption)

---

## 4. External Services

### Confirmed Stack

| Service | Purpose | Config |
|---------|---------|--------|
| **CoinMarketCap** | WEALTH price USD | `CMC_API_KEY` env |
| **open.er-api.com** | USD/IDR rate (free, cached 15min) | No key |
| **Alchemy RPC** | Ethereum mainnet | `ALCHEMY_RPC_URL` env (mainnet only, no Sepolia in prod) |
| **Alchemy Webhook** | Address activity → confirm redemption | `ALCHEMY_WEBHOOK_SIGNING_KEY` env, HMAC verify |
| **Cloudflare R2** | QR images (private bucket) + merchant logos (public bucket) | Sync env var names: `R2_ACCOUNT_ID`, `R2_QR_BUCKET_NAME`, `R2_LOGO_BUCKET_NAME`, `R2_LOGO_PUBLIC_URL` |
| **Etherscan** | (Block explorer link in FE only, no backend integration) | N/A |

### Env Vars (replacing AppSettings DB columns)

Pindah ke env (no UI editable):
- `WEALTH_CONTRACT_ADDRESS` — ERC-20 contract address mainnet
- `DEV_WALLET_ADDRESS` — treasury wallet address
- `ALCHEMY_RPC_URL` — RPC endpoint
- `ETHEREUM_CHAIN_ID` — must explicitly = 1 (mainnet) in production

Di DB tetep:
- `app_settings.appFeeRate` (Manager edit via UI)
- `app_settings.gasFeeAmount` (Manager edit via UI)

---

## 5. Cleanup (Drop)

### Schema
- `AppSettings.coingeckoApiKey` — dead field
- `AppSettings.alchemyRpcUrl` — pindah ke env
- `AppSettings.wealthContractAddress` — pindah ke env
- `AppSettings.devWalletAddress` — pindah ke env
- `fee_settings` table — replace dengan field di `app_settings`
- `qr_codes.token` field — legacy fallback, scan pake UUID id only

### Endpoints
- `POST /admin/qr-codes` — deprecated manual creation
- `GET /admin/fee-settings/active` — drop
- `POST /admin/fee-settings/:id/activate` — drop
- All `/admin/fee-settings/*` CRUD — drop
- `POST /api/setup/init-owner` — drop after first owner created (atau feature flag)

### Code Files
- `services/fee-setting.ts` — exported but never imported (logic duplicated inline anyway, drop both)

---

## 6. Bug Fixes (Mandatory Before Mainnet Launch)

| # | Issue | Fix |
|---|-------|-----|
| 1 | Webhook signature unverified | Implement HMAC-SHA256 verify, reject invalid 401 |
| 2 | Client-supplied price | Backend fetch own price from CMC cache, reject body field |
| 3 | Stock double-decrement | Single decrement at `confirmRedemption()` only, drop di QR scan |
| 4 | Login rate limiter not applied | Apply existing `loginLimiter` + `setPasswordLimiter` |
| 5 | Categories migration missing | Drop `categories` table, replace with enum (auto-resolve) |
| 6 | Seed broken | Fix after schema rewrite (fresh start) |
| 7 | R2 env var mismatch | Sync `.env.example` with code-read names |
| 8 | Sepolia default in prod | Explicit `ETHEREUM_CHAIN_ID=1` in production deployment |

---

## 7. Stack Decisions Summary

| Concern | Decision |
|---------|----------|
| Framework | Hono on Vercel serverless |
| ORM | Prisma + Postgres (Supabase) |
| Auth library | Better Auth + Hono adapter |
| Session | Database session, multi-device |
| Rate limit | In-memory (Phase 1) |
| Price cache | 60s in-memory (CMC), 15min FX |
| Treasury balance | viem `balanceOf`, cache 60s |
| Confirmation | Webhook primary + auto-reconcile fallback (lazy 30s) |
| File upload | R2, 2MB max, PNG/WebP/JPEG |
| Soft delete | Default filter `deletedAt IS NULL`, no restore feature |
| Migration strategy | Fresh start, no data carry-over |

---

## 8. Implementation Dependencies

**Order of attack (recommended):**

1. **Schema migration** — fresh start. New `users`, `admins`, `sessions`, `password_setup_tokens`, `app_settings`. Drop `fee_settings`, dead fields. Update existing tables (vouchers, redemptions, qr_codes) untuk denormalize email + drop legacy fields.
2. **Better Auth integration** — install + Hono adapter + middleware rewrite.
3. **Custom auth endpoints** — setup-password, change-password, sign-out-others, owner reset.
4. **Endpoint refactor** — Owner endpoints first (simpler), Manager endpoints, Admin scoping last.
5. **Bug fixes** — webhook HMAC, price validation, stock decrement, rate limit apply, R2 env sync.
6. **Cleanup** — drop dead endpoints, files, fields.
7. **Treasury balance implement** — viem + cache.

**Backend ready** = back-office FE refactor bisa start.
