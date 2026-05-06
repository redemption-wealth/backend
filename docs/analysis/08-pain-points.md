# 08 — Pain Points & Inconsistencies

All findings have file + line references. Severity: 🔴 Critical / 🟠 High / 🟡 Medium / 🔵 Low

---

## 🔴 P1 — Webhook Signature Not Verified

**File**: `src/routes/webhook.ts:17-20`

```typescript
// TODO: Verify signature with ALCHEMY_WEBHOOK_SIGNING_KEY
// const body = await c.req.text();
// const isValid = verifyAlchemySignature(...);
```

The `x-alchemy-signature` header is checked for presence but the HMAC is never verified. Any external caller can POST to `/api/webhook/alchemy` and trigger `confirmRedemption()` (mark a redemption as paid without actual on-chain payment) or `failRedemption()` (cancel a legitimate redemption). High-impact security vulnerability.

---

## 🔴 P2 — Client-Supplied Price Not Validated

**File**: `src/routes/vouchers.ts:93`, `src/services/redemption.ts:79-82`

`wealthPriceIdr` comes from the FE in the redeem body and is used directly for WEALTH amount calculation:
```typescript
const wealthAmount = totalIdr.div(wealthPriceDecimal);  // wealthPriceDecimal = client input
```

A user who sends `wealthPriceIdr = 1,000,000` (10× real price of ~100,000) would only need to pay 1/10th of the expected WEALTH. Backend should validate `wealthPriceIdr` against the server-side cached CMC price (within a tolerance, e.g., ±5%).

---

## 🔴 P3 — Double-Decrement of `remainingStock`

**Files**: `src/services/redemption.ts:177`, `src/routes/admin/qr-codes.ts:84`

`voucher.remainingStock` is decremented in two places for the same redemption:
1. **`confirmRedemption()`** (webhook) — decrements when on-chain tx is confirmed
2. **QR scan completion** — decrements when admin marks all QRs in a slot as used

**Flow**: initiate (no decrement) → webhook → decrement 1 → admin scans → decrement 2.

Net effect: each completed redemption reduces `remainingStock` by 2. A voucher with 10 slots shows `remainingStock = 10 - (redeems × 2)`. This makes the stock counter unreliable for both display and the `remaining_stock > 0` check in `initiateRedemption()`.

---

## 🟠 P4 — Rate Limiters Defined But Never Applied

**File**: `src/middleware/rate-limit.ts:45-56`

`loginLimiter` (5 req/15min) and `setPasswordLimiter` (3 req/15min) are exported from `rate-limit.ts` but never imported or applied in `src/routes/auth.ts`. Auth endpoints have no brute-force protection.

Only `qrScanLimiter` is actually used (`src/routes/admin/qr-codes.ts:10`).

---

## 🟠 P5 — R2 Env Var Name Mismatch

**File**: `src/services/r2.ts:13`

```typescript
endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`
```

`.env.example` defines `R2_ACCOUNT_ID`, not `CLOUDFLARE_ACCOUNT_ID`. If deployed following `.env.example`, all R2 operations (QR upload, logo upload, signed URLs) will silently fail with the wrong endpoint.

Additional mismatches:
- `.env.example`: `R2_BUCKET_NAME` → code uses `R2_QR_BUCKET_NAME` + `R2_LOGO_BUCKET_NAME`
- `.env.example`: `R2_PUBLIC_URL` → code uses `R2_LOGO_PUBLIC_URL` (`r2.ts:124`)

---

## 🟠 P6 — `coingeckoApiKey` Dead Field

**Files**: `prisma/schema.prisma:243`, `src/routes/admin/settings.ts:37,48`, `src/schemas/settings.ts:14`

The `AppSettings` model stores `coingeckoApiKey`, the settings endpoint accepts and persists it, but `src/services/price.ts` **only reads `process.env.CMC_API_KEY`** and never reads the DB field or any CoinGecko API. The `coingeckoApiKey` column and API field are dead weight — misleading to FE developers and to admins who configure it.

---

## 🟠 P7 — `POST /api/setup/init-owner` Never Deleted

**File**: `src/routes/setup.ts:3-8`

Comment says: *"IMPORTANT: Delete this endpoint after initial setup!"* but the endpoint persists in the codebase. It has a `SETUP_KEY` guard, but the endpoint itself is still exposed and the URL is predictable. Should either be removed post-setup or at minimum have a feature flag.

---

## 🟡 P8 — In-Memory Caches Ineffective on Serverless

**Files**: `src/services/price.ts:1-2`, `src/services/analytics.ts:4-7`, `src/middleware/rate-limit.ts:15`

Vercel serverless = ephemeral instances, no shared memory. Three module-level stores are effectively no-ops:
- `cachedPrice` / `cachedFx` — price cache resets every cold start
- `analyticsCache` (node-cache) — analytics TTL never persists
- Rate limit `Map` — resets per instance, no protection across instances

This means CMC is called on every request in production unless a single warm instance handles all traffic.

---

## 🟡 P9 — QR `imageUrl` Inconsistency Across Endpoints

**Files**: `src/routes/redemptions.ts:52,107`, `src/routes/admin/redemptions.ts:24,55`

- `GET /api/redemptions` (list) — returns raw R2 key (e.g., `qr-codes/uuid/1.png`)
- `GET /api/redemptions/:id` (detail) — signs URLs via `withSignedQrUrls()` → full `https://...` URL
- `GET /api/admin/redemptions` — returns raw R2 key (never signed)
- `GET /api/admin/redemptions/:id` — returns raw R2 key (never signed)

FE must handle both formats. Signed URLs expire after 1h (`QR_SIGNED_URL_TTL_SEC = 3600`). After expiry, QR image is inaccessible without re-fetching the detail endpoint.

---

## 🟡 P10 — Admin Object Shape Inconsistency

`POST /api/auth/login` response (`src/routes/auth.ts:80-90`):
```json
{ "id", "email", "role", "isActive", "createdAt", "updatedAt" }
```

`GET /api/auth/me` response (`src/routes/auth.ts:131`):
```json
{ "type": "admin", "adminId", "email", "role", "merchantId?" }
```

Two different shapes for "the current admin." FE must handle both or normalize at call site. `id` vs `adminId`, no `isActive` in `/me`, no `merchantId` in `/login`.

---

## 🟡 P11 — N+1 in Analytics

**File**: `src/services/analytics.ts:228-260`

`getTopMerchants()` and `getTopVouchers()` fetch ALL confirmed redemptions with nested includes, then aggregate in JavaScript:

```typescript
const redemptions = await prisma.redemption.findMany({
  where: { status: "confirmed" },
  include: { voucher: { include: { merchant: true } } },  // N+1 for all merchants
});
// aggregate in JS...
```

For a platform with thousands of redemptions, this will load all records into memory. Should use `GROUP BY` raw SQL or Prisma `groupBy()`.

---

## 🟡 P12 — Missing Migration for `categories` Table

**Evidence**: All 6 migration files examined. None create the `categories` table or migrate `merchants.category` (MerchantCategory enum) to `merchants.category_id` FK.

The `prisma/schema.prisma` declares `Category` model and `Merchant.categoryId` FK, but the migration history starts with a `MerchantCategory` enum and subsequent migrations never convert it. Likely created via `prisma db push` without a proper migration. `prisma migrate deploy` on a fresh DB may fail or produce inconsistent state.

---

## 🟡 P13 — Seed Broken After Latest Migration

**File**: `prisma/seed.ts:38`, migration `20260424`

After dropping the absolute unique index on `admins.email` (replaced by partial unique), `prisma.admin.upsert({ where: { email } })` requires `email` to be declared `@unique` in `schema.prisma`. It is not. The seed script will fail with a Prisma validation error on the current schema.

---

## 🟡 P14 — `POST /api/admin/vouchers` Missing Role Guard

**File**: `src/routes/admin/vouchers.ts:84`

All other write operations on admin-managed resources have explicit `requireManager` or `requireOwner`. Voucher creation only has `requireAdmin` (base auth). An `admin` role user can create vouchers — they're force-scoped to their merchantId, but the intent per the role matrix appears to be manager+ for creation.

---

## 🟡 P15 — Voucher Category Filter Broken

**File**: `src/routes/vouchers.ts:32-35`

```typescript
...(category && {
  merchant: { category: category as never },  // ← wrong
}),
```

`Merchant.category` in the current schema is a `Category` relation (object), not a string field. The correct filter would be `merchant: { category: { name: { equals: category } } }`. As written, Prisma may throw a runtime error or silently ignore this filter when `category` is passed.

---

## 🔵 P16 — Analytics Double `requireAdmin`

**File**: `src/routes/admin/analytics.ts:15`

```typescript
adminAnalytics.use("/*", requireAdmin);  // redundant
```

Already covered by `admin.use("*", requireAdmin)` in `src/app.ts:65`. Each analytics request performs TWO DB lookups for the same admin record. Harmless but wasteful — costs one extra Postgres round-trip per request.

---

## 🔵 P17 — `GET /api/merchants/:id` Includes Deleted

**File**: `src/routes/merchants.ts:46`

The detail endpoint uses `findUnique({ where: { id } })` without a `deletedAt: null` filter, meaning soft-deleted merchants are still accessible via direct URL. The list endpoint correctly filters `isActive: true`.

---

## 🔵 P18 — `fee-setting.ts` Service Unused

**File**: `src/services/fee-setting.ts`

Exports `getActiveFee()`, `activateFee()`, `deactivateFee()`. None are imported anywhere — the admin fee-settings route (`src/routes/admin/fee-settings.ts`) implements the same logic inline. Dead service file.

---

## 🔵 P19 — Treasury Balance is a Permanent Stub

**File**: `src/routes/admin/analytics.ts:103-125`

`GET /api/admin/analytics/treasury-balance` always returns `balance: "0"` with a note about pending blockchain integration. No timeline or flag for when this will be implemented. FE should not display this endpoint's balance as real data.

---

## 🔵 P20 — `POST /api/admin/qr-codes` Legacy Endpoint

**File**: `src/routes/admin/qr-codes.ts:149`, `src/schemas/qr-code.ts:5`

Manual QR code creation. Schema comment: `// DEPRECATED: QR codes are now auto-generated with vouchers via slots`. Endpoint is still live but should not be called by any current FE flow.
