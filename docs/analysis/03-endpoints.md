# 03 — Endpoint Inventory

All paths are prefixed as shown. Response wrapper key is always present (e.g., `{ merchants: [...] }`).

---

## Health

### `GET /api/health`
- **Purpose**: Liveness check
- **Auth**: Public
- **Response**: `{ status: "ok", timestamp: string }`
- **File**: `src/app.ts:48`

---

## /api/auth

### `POST /api/auth/check-email`
- **Purpose**: Pre-login check — tells FE whether admin needs first-time password setup
- **Auth**: Public
- **Body**: `{ email: string }`
- **Response (found, no pw)**: `{ needs_password_setup: true, email: string }`
- **Response (found, has pw)**: `{ needs_password_setup: false, email: string }`
- **Response (not found)**: `401 { error: "Email tidak terdaftar" }`
- **File**: `src/routes/auth.ts:15`

### `POST /api/auth/login`
- **Purpose**: Admin login, returns JWT
- **Auth**: Public (⚠️ `loginLimiter` defined but NOT applied)
- **Body**: `{ email: string, password: string }` (Zod: min 1, max 128)
- **Response (success)**: `{ token: string, admin: { id, email, role, isActive, createdAt, updatedAt } }`
- **Response (first login)**: `200 { needs_password_setup: true, email: string }`
- **Response (invalid)**: `401 { error: "Invalid credentials" }`
- **File**: `src/routes/auth.ts:41`

### `POST /api/auth/set-password`
- **Purpose**: First-login password initialization
- **Auth**: Public (⚠️ `setPasswordLimiter` defined but NOT applied)
- **Body**: `{ email: string, password: string (min 8), confirmPassword: string }`
- **Response**: `{ message: "Password set successfully" }`
- **Error (already set)**: `409 { error: "Password already set" }`
- **File**: `src/routes/auth.ts:94`

### `GET /api/auth/me`
- **Purpose**: Get current admin profile from JWT
- **Auth**: `requireAdmin`
- **Response**: `{ admin: AdminAuth }` — `AdminAuth = { type, adminId, email, role, merchantId? }`
- **Note**: Shape differs from `/login` response (`adminId` vs `id`, no `isActive`/timestamps)
- **File**: `src/routes/auth.ts:129`

### `PATCH /api/auth/change-password`
- **Purpose**: Change own password
- **Auth**: `requireAdmin`
- **Body**: `{ currentPassword: string, newPassword: string (min 8, max 128) }`
- **Response**: `{ message: "Password berhasil diubah" }`
- **File**: `src/routes/auth.ts:135`

### `POST /api/auth/user-sync`
- **Purpose**: Sync Privy user to local DB (upsert)
- **Auth**: Privy Bearer token (manual check, not via `requireUser` middleware)
- **Headers**: `Authorization: Bearer <privy-token>`
- **Response**: `{ user: { id, email, privyUserId, walletAddress?, createdAt, updatedAt } }`
- **File**: `src/routes/auth.ts:173`

---

## /api/merchants (Public)

### `GET /api/merchants`
- **Purpose**: List active non-deleted merchants
- **Auth**: Public
- **Query**: `categoryId? (uuid)`, `search? (string)`, `page? (default 1)`, `limit? (default 20)`
- **Response**: `{ merchants: Merchant[], pagination: { page, limit, total, totalPages } }`
- **Includes**: `category: { name }` on each merchant
- **File**: `src/routes/merchants.ts:8`

### `GET /api/merchants/:id`
- **Purpose**: Get merchant detail with active vouchers
- **Auth**: Public
- **Response**: `{ merchant: Merchant & { vouchers: Voucher[] } }`
- **Note**: Returns deleted merchants (no `deletedAt` filter on this endpoint)
- **File**: `src/routes/merchants.ts:45`

---

## /api/vouchers (Public + User)

### `GET /api/vouchers`
- **Purpose**: List active, in-stock, non-expired vouchers
- **Auth**: Public
- **Query**: `merchantId? (uuid)`, `category? (string)`, `search? (string)`, `page?`, `limit?`
- **Response**: `{ vouchers: Voucher[], pagination: { page, limit, total, totalPages } }`
- **Filters applied**: `isActive=true`, `remainingStock > 0`, `expiryDate >= now`
- **⚠️ Bug**: `category` filter uses `merchant: { category: string }` but `Merchant.category` is a relation (Category object), not a string — this filter is broken for the new schema
- **File**: `src/routes/vouchers.ts:10`

### `GET /api/vouchers/:id`
- **Purpose**: Get voucher detail
- **Auth**: Public
- **Response**: `{ voucher: Voucher & { merchant: Merchant } }`
- **File**: `src/routes/vouchers.ts:64`

### `POST /api/vouchers/:id/redeem`
- **Purpose**: Initiate voucher redemption — allocates slot, generates QR(s), returns tx details
- **Auth**: `requireUser` (Privy)
- **Body**: `{ idempotencyKey: uuid, wealthPriceIdr: number (positive) }`
- **Response (new)**: `{ redemption: Redemption, txDetails: { tokenContractAddress, treasuryWalletAddress, wealthAmount: string } }`
- **Response (idempotent)**: `{ redemption: Redemption, alreadyExists: true }`
- **Side effects**: Generates QR PNG(s) → uploads to R2, creates Redemption + assigns slot QR codes
- **⚠️ Security**: `wealthPriceIdr` from client is trusted without server-side price validation
- **File**: `src/routes/vouchers.ts:80`

---

## /api/redemptions (User-scoped)

### `GET /api/redemptions`
- **Purpose**: List current user's redemptions
- **Auth**: `requireUser`
- **Query**: `page?`, `limit? (default 20)`, `status? (pending|confirmed|failed)`
- **Response**: `{ redemptions: Redemption[], pagination: { page, limit, total, totalPages } }`
- **Includes**: `voucher + merchant`, `qrCodes`
- **⚠️ Inconsistency**: QR `imageUrl` in list is raw R2 key (NOT signed URL). Detail endpoint signs them.
- **File**: `src/routes/redemptions.ts:38`

### `GET /api/redemptions/:id`
- **Purpose**: Get redemption detail with signed QR URLs; auto-reconciles if pending+txHash
- **Auth**: `requireUser` (ownership enforced)
- **Response**: `{ redemption: Redemption & { qrCodes: QrCode[], transaction: Transaction? } }`
- **Side effect**: Auto-calls `reconcileRedemptionById()` if status=pending and txHash present
- **File**: `src/routes/redemptions.ts:75`

### `POST /api/redemptions/:id/reconcile`
- **Purpose**: Force on-chain re-check for pending redemption
- **Auth**: `requireUser` (ownership enforced)
- **Response**: `{ redemption: Redemption, reconciled: boolean }`
- **File**: `src/routes/redemptions.ts:111`

### `PATCH /api/redemptions/:id/submit-tx`
- **Purpose**: Submit on-chain txHash after user broadcasts transaction
- **Auth**: `requireUser` (ownership enforced)
- **Body**: `{ txHash: string }` (validated: `0x` + 64 hex chars)
- **Response**: `{ redemption: Redemption }` (only DB record, not signed URLs)
- **File**: `src/routes/redemptions.ts:147`

---

## /api/transactions (User-scoped)

### `GET /api/transactions`
- **Purpose**: List current user's transaction history
- **Auth**: `requireUser`
- **Query**: `page?`, `limit? (default 20)`, `type? (deposit|withdrawal|redeem)`
- **Response**: `{ transactions: Transaction[], pagination: { page, limit, total, totalPages } }`
- **File**: `src/routes/transactions.ts:8`

---

## /api/price

### `GET /api/price/wealth`
- **Purpose**: Get current WEALTH price in IDR (CMC + FX, cached 60s)
- **Auth**: Public
- **Response**: `{ priceIdr: number, cached: boolean, stale?: boolean }`
- **File**: `src/routes/price.ts:7`

---

## /api/webhook

### `POST /api/webhook/alchemy`
- **Purpose**: Receive Alchemy activity webhook for tx confirmation/failure
- **Auth**: None (⚠️ signature in header `x-alchemy-signature` is presence-checked but NOT verified)
- **Body**: Alchemy activity webhook payload `{ event: { activity: [{ hash, category, typeTraceAddress }] } }`
- **Response**: `{ ok: true }`
- **Side effects**: Calls `confirmRedemption()` or `failRedemption()` per activity
- **File**: `src/routes/webhook.ts:9`

---

## /api/categories (Public)

### `GET /api/categories`
- **Purpose**: List active categories
- **Auth**: Public
- **Response**: `{ data: [{ id: string, name: string }] }` ← note `data` wrapper (inconsistent with other endpoints)
- **File**: `src/routes/categories.ts:10`

### `GET /api/categories/:id`
- **Purpose**: Get category by ID
- **Auth**: Public
- **Response**: `{ data: { id, name, isActive } }`
- **File**: `src/routes/categories.ts:27`

---

## /api/setup

### `POST /api/setup/init-owner`
- **Purpose**: One-time bootstrap — creates owner account, default settings, categories, fee setting
- **Auth**: `SETUP_KEY` in request body (no JWT)
- **Body**: `{ email: string, password: string, setupKey: string }`
- **Response**: `{ success: true, owner: { id, email, role } }`
- **Guard**: Fails if any `owner` role admin already exists
- **⚠️ Note**: Never actually deleted — comment says "Delete this endpoint after initial setup" but it remains in the codebase
- **File**: `src/routes/setup.ts:15`

---

## /api/admin/merchants (All: requireAdmin; role gates below)

### `GET /api/admin/merchants/select`
- **Purpose**: Unassigned merchants dropdown (for admin assignment form)
- **Auth**: `requireOwner`
- **Response**: `{ merchants: [{ id, name }] }`
- **File**: `src/routes/admin/merchants.ts:16`

### `GET /api/admin/merchants`
- **Purpose**: List all merchants (no soft-deleted)
- **Auth**: `requireAdmin`
- **Query**: `categoryId?`, `search?`, `page?`, `limit?`
- **Response**: `{ merchants: Merchant[], pagination }`
- **Includes**: `creator: { email }`, `category: { name }`
- **Note**: No merchant scoping for `admin` role (all merchants visible)
- **File**: `src/routes/admin/merchants.ts:63`

### `GET /api/admin/merchants/:id`
- **Purpose**: Get merchant detail
- **Auth**: `requireAdmin`; `admin` role restricted to own merchant
- **Response**: `{ merchant: Merchant & { creator, category } }`
- **File**: `src/routes/admin/merchants.ts:38`

### `POST /api/admin/merchants`
- **Purpose**: Create merchant
- **Auth**: `requireManager` (owner or manager)
- **Body**: `{ name: string(2-200), description?, categoryId: uuid, logoUrl? }`
- **Response**: `201 { merchant: Merchant }`
- **File**: `src/routes/admin/merchants.ts:113`

### `PUT /api/admin/merchants/:id`
- **Purpose**: Update merchant
- **Auth**: `requireManager`
- **Body**: `{ name?, description?, categoryId?, logoUrl?, isActive? }`
- **Response**: `{ merchant: Merchant }`
- **File**: `src/routes/admin/merchants.ts:137`

### `DELETE /api/admin/merchants/:id`
- **Purpose**: Soft-delete merchant
- **Auth**: `requireManager`
- **Response**: `{ ok: true }`
- **File**: `src/routes/admin/merchants.ts:161`

---

## /api/admin/vouchers (All: requireAdmin; role gates below)

### `GET /api/admin/vouchers`
- **Purpose**: List vouchers; `admin` role sees only own merchant's
- **Auth**: `requireAdmin`
- **Query**: `merchantId?`, `search?`, `page?`, `limit?`
- **Response**: `{ vouchers: Voucher[], pagination }`
- **File**: `src/routes/admin/vouchers.ts:18`

### `GET /api/admin/vouchers/:id`
- **Purpose**: Get voucher detail
- **Auth**: `requireAdmin`; `admin` role restricted to own merchant
- **Response**: `{ voucher: Voucher & { merchant: Merchant } }`
- **File**: `src/routes/admin/vouchers.ts:62`

### `POST /api/admin/vouchers`
- **Purpose**: Create voucher with atomic slot + QR placeholder generation
- **Auth**: `requireAdmin` (⚠️ no `requireManager` — `admin` role can create vouchers)
- **Body**: `{ merchantId: uuid, title: string(2-200), description?, startDate, expiryDate, totalStock: int+, basePrice: number(min 1000), qrPerSlot?: 1|2 }`
- **Response**: `201 { voucher, slotsCreated: number, qrCodesCreated: number }`
- **Note**: QR `imageUrl` set to placeholder `https://placeholder.qr/{id}` — real QRs generated at redeem time
- **File**: `src/routes/admin/vouchers.ts:84`

### `PUT /api/admin/vouchers/:id`
- **Purpose**: Update voucher; handles stock changes with slot management
- **Auth**: `requireAdmin`; `admin` role restricted to own merchant
- **Body**: `{ title?, description?, startDate?, expiryDate?, totalStock?, isActive? }`
- **Note**: `basePrice`, `appFeeRate`, `gasFeeAmount`, `totalPrice`, `qrPerSlot` are read-only after creation
- **Response**: `{ voucher: Voucher }`
- **File**: `src/routes/admin/vouchers.ts:204`

### `DELETE /api/admin/vouchers/:id`
- **Purpose**: Soft-delete voucher (blocked if active QR codes exist)
- **Auth**: `requireAdmin`; `admin` role restricted to own merchant
- **Response**: `{ ok: true }`
- **Error**: `422 { error: "Cannot delete voucher with active QR codes", code: "VOUCHER_HAS_ACTIVE_QR" }`
- **File**: `src/routes/admin/vouchers.ts:365`

---

## /api/admin/qr-codes (All: requireAdmin)

### `POST /api/admin/qr-codes/scan`
- **Purpose**: Mark QR code as used; completes slot if all QRs scanned
- **Auth**: `requireAdmin` + `qrScanLimiter` (60/min per adminId); `admin` role merchant-scoped
- **Body**: `{ id?: uuid, token?: string }` (at least one required; `token` is legacy)
- **Response**: `{ success: true, voucherId, voucherTitle, merchantName, usedAt, scannedByAdminId, slotCompleted: boolean }`
- **Error codes**: `NOT_FOUND (404)`, `WRONG_MERCHANT (403)`, `QR_NOT_REDEEMED (422)`, `ALREADY_USED (409)`
- **File**: `src/routes/admin/qr-codes.ts:10`

### `GET /api/admin/qr-codes`
- **Purpose**: List QR codes; `admin` role merchant-scoped
- **Auth**: `requireAdmin`
- **Query**: `voucherId?`, `status? (available|redeemed|used)`, `page?`, `limit? (default 50)`
- **Response**: `{ qrCodes: QrCode[], pagination }`
- **File**: `src/routes/admin/qr-codes.ts:106`

### `POST /api/admin/qr-codes`
- **Purpose**: Manual QR code creation (deprecated/legacy)
- **Auth**: `requireAdmin`
- **Body**: `{ voucherId: uuid, slotId: uuid, qrNumber: 1|2, imageUrl: url, imageHash: string }`
- **Response**: `201 { qrCode: QrCode }`
- **Note**: Schema comment says "DEPRECATED: QR codes are now auto-generated with vouchers via slots"
- **File**: `src/routes/admin/qr-codes.ts:149`

---

## /api/admin/redemptions (All: requireAdmin)

### `GET /api/admin/redemptions`
- **Purpose**: List redemptions; `admin` role merchant-scoped
- **Auth**: `requireAdmin`
- **Query**: `status?`, `page?`, `limit?`
- **Response**: `{ redemptions: Redemption[], pagination }`
- **Includes**: `user: { email, walletAddress }`, `voucher + merchant`, `qrCodes`
- **⚠️ Note**: `qrCodes.imageUrl` returned as raw R2 key (NOT signed) — inconsistent with user endpoint
- **File**: `src/routes/admin/redemptions.ts:8`

### `GET /api/admin/redemptions/:id`
- **Purpose**: Get redemption detail
- **Auth**: `requireAdmin`; `admin` role restricted to own merchant
- **Response**: `{ redemption: Redemption & { user, voucher, qrCodes, transaction } }`
- **File**: `src/routes/admin/redemptions.ts:48`

---

## /api/admin/admins (All: requireOwner)

### `GET /api/admin/admins`
- **Purpose**: List all admins with filtering
- **Auth**: `requireOwner`
- **Query**: `role? (owner|manager|admin)`, `isActive?`, `search?`, `page?`, `limit?`
- **Response**: `{ admins: AdminSummary[], pagination }`
- **File**: `src/routes/admin/admins.ts:16`

### `GET /api/admin/admins/:id`
- **Purpose**: Get admin detail
- **Auth**: `requireOwner`
- **Response**: `{ admin: AdminDetail & { assignedMerchant?: { id, name } } }`
- **File**: `src/routes/admin/admins.ts:77`

### `POST /api/admin/admins`
- **Purpose**: Create admin account
- **Auth**: `requireOwner`
- **Body**: `{ email, password? (min 8), role: owner|manager|admin (default manager), merchantId?: uuid }`
- **Validation**: `admin` role requires `merchantId`; non-admin roles forbid `merchantId`
- **Response**: `201 { admin: AdminSummary }`
- **File**: `src/routes/admin/admins.ts:104`

### `PUT /api/admin/admins/:id`
- **Purpose**: Update admin (isActive, merchantId only)
- **Auth**: `requireOwner`
- **Body**: `{ isActive?: boolean, merchantId?: uuid | null }`
- **Note**: `merchantId` updates only allowed for `admin` role
- **Response**: `{ admin: AdminSummary }`
- **File**: `src/routes/admin/admins.ts:165`

### `POST /api/admin/admins/:id/reset-password`
- **Purpose**: Force re-set password (sets passwordHash to null → triggers first-login flow)
- **Auth**: `requireOwner`
- **Guard**: Cannot reset self; cannot reset last active owner
- **Response**: `{ ok: true }`
- **File**: `src/routes/admin/admins.ts:229`

### `DELETE /api/admin/admins/:id`
- **Purpose**: Soft-delete admin
- **Auth**: `requireOwner`
- **Guard**: Cannot delete self; cannot delete last active owner
- **Response**: `{ ok: true }`
- **File**: `src/routes/admin/admins.ts:260`

---

## /api/admin/analytics (All: requireAdmin)

### `GET /api/admin/analytics/summary`
- **Purpose**: Dashboard KPIs — totals for merchants, vouchers, redemptions, WEALTH volume
- **Auth**: `requireAdmin`; `admin` role merchant-scoped
- **Response**: `{ summary: { totalMerchants, totalVouchers, totalRedemptions, confirmedRedemptions, totalWealthVolume: string, totalUsers, avgWealthPerRedeem: string, totalValueIdr: number } }`
- **Cache**: 5 min (node-cache, per-instance)
- **File**: `src/routes/admin/analytics.ts:18`

### `GET /api/admin/analytics/recent-activity`
- **Purpose**: Recent confirmed redemptions feed
- **Auth**: `requireAdmin`; `admin` role merchant-scoped
- **Query**: `limit? (max 50, default 10)`
- **Response**: `{ activities: Redemption[] }` (includes user.email, voucher.merchant.name)
- **File**: `src/routes/admin/analytics.ts:26`

### `GET /api/admin/analytics/redemptions-over-time`
- **Purpose**: Redemption count time-series
- **Auth**: `requireAdmin`; `admin` role merchant-scoped
- **Query**: `period: daily|monthly|yearly`
- **Response**: `{ data: [{ label: string, count: number }] }`
- **Note**: `daily` = last 7 days, `monthly` = last 6 months, `yearly` = last 5 years
- **File**: `src/routes/admin/analytics.ts:48`

### `GET /api/admin/analytics/merchant-categories`
- **Auth**: `requireAdmin`
- **Response**: `{ data: [{ category: string, count: number, percentage: number }] }`
- **File**: `src/routes/admin/analytics.ts:62`

### `GET /api/admin/analytics/wealth-volume`
- **Auth**: `requireAdmin`; `admin` role merchant-scoped
- **Query**: `period: daily|monthly|yearly`
- **Response**: `{ data: [{ label: string, volume: string }] }`
- **File**: `src/routes/admin/analytics.ts:70`

### `GET /api/admin/analytics/top-merchants`
- **Auth**: `requireAdmin`
- **Query**: `limit? (max 10, default 3)`
- **Response**: `{ data: [{ id, name, logoUrl, redeemCount, wealthVolume: string }] }`
- **File**: `src/routes/admin/analytics.ts:84`

### `GET /api/admin/analytics/top-vouchers`
- **Auth**: `requireAdmin`
- **Query**: `limit? (max 10, default 3)`
- **Response**: `{ data: [{ id, title, merchantName, redeemCount, wealthVolume: string }] }`
- **File**: `src/routes/admin/analytics.ts:92`

### `GET /api/admin/analytics/treasury-balance`
- **Purpose**: Placeholder — blockchain integration not implemented
- **Auth**: `requireAdmin`
- **Response**: `{ balance: "0", tokenAddress, treasuryAddress, note: "...placeholder..." }`
- **File**: `src/routes/admin/analytics.ts:103`

---

## /api/admin/fee-settings (All: requireAdmin)

### `GET /api/admin/fee-settings`
- **Auth**: `requireAdmin` (all roles)
- **Response**: `{ feeSettings: FeeSetting[] }` (no pagination)
- **File**: `src/routes/admin/fee-settings.ts:12`

### `POST /api/admin/fee-settings`
- **Auth**: `requireManager`
- **Body**: `{ label: string(2-100), amountIdr: integer ≥ 0 }`
- **Response**: `201 { feeSetting: FeeSetting }`
- **File**: `src/routes/admin/fee-settings.ts:20`

### `PUT /api/admin/fee-settings/:id`
- **Auth**: `requireManager`
- **Body**: `{ label?, amountIdr? }`
- **Response**: `{ feeSetting: FeeSetting }`
- **File**: `src/routes/admin/fee-settings.ts:39`

### `POST /api/admin/fee-settings/:id/activate`
- **Purpose**: Activate fee (deactivates all others atomically)
- **Auth**: `requireManager`
- **Response**: `{ feeSetting: FeeSetting }`
- **File**: `src/routes/admin/fee-settings.ts:63`

### `DELETE /api/admin/fee-settings/:id`
- **Auth**: `requireManager`
- **Guard**: Cannot delete the active fee setting
- **Response**: `{ ok: true }`
- **File**: `src/routes/admin/fee-settings.ts:87`

---

## /api/admin/settings (All: requireOwner)

### `GET /api/admin/settings`
- **Purpose**: Get AppSettings singleton (includes treasury wallet — owner-only sensitive)
- **Auth**: `requireOwner`
- **Response**: `{ settings: AppSettings }` — includes `coingeckoApiKey` field (unused by price service)
- **File**: `src/routes/admin/settings.ts:9`

### `PUT /api/admin/settings`
- **Auth**: `requireOwner`
- **Body**: `{ appFeeRate?: number(0-50), wealthContractAddress?, devWalletAddress?: 0x-address, alchemyRpcUrl?, coingeckoApiKey? }`
- **Note**: `coingeckoApiKey` field stored in DB but NOT read by `services/price.ts` which uses `CMC_API_KEY` env var
- **Response**: `{ settings: AppSettings }`
- **File**: `src/routes/admin/settings.ts:24`

---

## /api/admin/upload

### `POST /api/admin/upload/logo`
- **Purpose**: Upload merchant logo to R2 public bucket
- **Auth**: `requireManager`
- **Body**: multipart/form-data, field `file` or `logo`
- **Validation**: max 5MB, must be image MIME type
- **Response**: `{ url: string, filename: string, size: number, contentType: string }`
- **File**: `src/routes/admin/upload.ts:13`

---

## Endpoint Count Summary

| Group | Count |
|-------|-------|
| Health | 1 |
| /api/auth | 6 |
| /api/merchants | 2 |
| /api/vouchers | 3 |
| /api/redemptions | 4 |
| /api/transactions | 1 |
| /api/price | 1 |
| /api/webhook | 1 |
| /api/categories | 2 |
| /api/setup | 1 |
| /api/admin/merchants | 6 |
| /api/admin/vouchers | 5 |
| /api/admin/qr-codes | 3 |
| /api/admin/redemptions | 2 |
| /api/admin/admins | 6 |
| /api/admin/analytics | 8 |
| /api/admin/fee-settings | 5 |
| /api/admin/settings | 2 |
| /api/admin/upload | 1 |
| **Total** | **60** |
