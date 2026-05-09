# 07 — Business Logic Critical Paths

## Flow 1: Voucher Redemption (End-to-End)

### Step 1 — Price Fetch (optional but recommended)
```
FE: GET /api/price/wealth
BE: → CMC API (slug lookup) → USD price
    → open.er-api.com → USD/IDR rate
    → priceIdr = priceUsd × usdToIdr
Response: { priceIdr, cached, stale? }
```
FE typically uses this price to pass as `wealthPriceIdr` in the redeem call.

**⚠️ Security gap**: FE sends `wealthPriceIdr` — backend does NOT validate it against its own cached price. A user can pass an inflated price (e.g., 10× real) and pay 1/10th the WEALTH required.

### Step 2 — Initiate Redemption
```
FE: POST /api/vouchers/:id/redeem
    Body: { idempotencyKey: uuid, wealthPriceIdr: number }
```

Backend calls `initiateRedemption()` (`src/services/redemption.ts:15`):

1. **Idempotency check**: `redemption.findFirst({ where: { idempotencyKey, userId } })` — if found, return existing (safe retry)
2. **Config fetch**: AppSettings (app fee rate) + active FeeSetting (gas fee IDR)
3. **BEGIN TRANSACTION** (`prisma.$transaction`):
   - **Row lock**: `SELECT ... FROM vouchers WHERE id=$1 FOR UPDATE` (prevents overselling)
   - Validate: `is_active`, `remaining_stock > 0`, `expiry_date >= now`
   - **Pricing calculation**:
     ```
     appFeeInIdr = basePrice × appFeePercentage / 100
     totalIdr = basePrice + appFeeInIdr + gasFeeIdr
     wealthAmount = totalIdr / wealthPriceIdr   ← client-supplied price
     appFeeAmount = appFeeInIdr / wealthPriceIdr
     gasFeeAmount = gasFeeIdr / wealthPriceIdr
     ```
   - **QR generation**: `generateQrCode(redemptionId, i+1)` per QR in slot:
     - Generate 32-byte random token
     - Render token as QR PNG
     - Upload to R2: `qr-codes/{redemptionId}/{i}.png`
     - Returns `{ token, imageUrl (R2 key), imageHash (SHA-256) }`
   - **Create Redemption** record (status: `pending`)
   - **Find available slot**: `redemptionSlot.findFirst({ where: { voucherId, status: "available" } })`
   - **Update slot**: status → `redeemed`, `redeemedAt = now`
   - **Update slot's QR codes**: status → `redeemed`, assign `imageUrl`, `imageHash`, `token`, `assignedToUserId`, `redemptionId`
4. Return `{ redemption, alreadyExists: false }`

**Note**: R2 uploads happen inside the Prisma transaction callback but R2 is not transactional. On DB failure, a compensating `deleteQrFiles()` is called in the catch block.

**Response to FE**:
```json
{
  "redemption": { "id", "wealthAmount", "status": "pending", ... },
  "txDetails": {
    "tokenContractAddress": "AppSettings.wealthContractAddress",
    "treasuryWalletAddress": "AppSettings.devWalletAddress",
    "wealthAmount": "123.456789..."
  }
}
```

### Step 3 — On-Chain Transfer (FE responsibility)
FE must broadcast a WEALTH ERC-20 `transfer()` transaction to `treasuryWalletAddress` for `wealthAmount` tokens.

### Step 4 — Submit txHash
```
FE: PATCH /api/redemptions/:id/submit-tx
    Body: { txHash: "0x..." }
```
Backend validates format (`0x` + 64 hex chars), checks uniqueness, updates `redemption.txHash`.

### Step 5 — Confirmation (via Webhook)
```
Alchemy → POST /api/webhook/alchemy
         { event: { activity: [{ hash, category: "token", typeTraceAddress: "CALL" }] } }
```

Backend calls `confirmRedemption(txHash)` (`src/services/redemption.ts:164`):
1. Find `redemption` where `txHash = ?` and `status = pending`
2. Update redemption: `status → confirmed`, `confirmedAt = now`
3. **Decrement `voucher.remainingStock`** ← first decrement
4. Create `Transaction` record (type: `redeem`, status: `confirmed`)

### Alternative Step 5 — Auto-Reconcile
If FE polls `GET /api/redemptions/:id` and redemption is still `pending` with a `txHash`, the endpoint auto-calls `reconcileRedemptionById()` which does a `viem.getTransactionReceipt()` via Alchemy RPC and confirms/fails accordingly.

### Failure Path
If `activity.category !== "token"` or receipt fails → `failRedemption(txHash)`:
1. Load redemption + QR codes
2. **Best-effort R2 cleanup**: delete QR PNG files from R2
3. DB transaction: delete QR code records, mark redemption `failed`

---

## Flow 2: QR Scan / Validation (Merchant Admin)

```
Admin: POST /api/admin/qr-codes/scan
       Body: { id: uuid } or { token: string }
```

Handler (`src/routes/admin/qr-codes.ts:10`):
1. **Rate limit**: 60 req/min per adminId (`qrScanLimiter`)
2. Find QR by `id` or `token` (token is legacy fallback)
3. **Merchant scoping**: admin role checks `qrCode.voucher.merchantId === adminAuth.merchantId`
4. Status checks:
   - `available` → 422 QR_NOT_REDEEMED (user hasn't redeemed yet)
   - `used` → 409 ALREADY_USED
   - Only `redeemed` proceeds
5. **BEGIN TRANSACTION**:
   - Mark QR: `status → used`, `usedAt = now`, `scannedByAdminId = adminId`
   - Count remaining non-used QRs in slot: `qrCode.count({ where: { slotId, status: { not: "used" } } })`
   - If all used (`unusedCount === 0`):
     - Update slot: `status → fully_used`
     - **Decrement `voucher.remainingStock`** ← second decrement ⚠️

**⚠️ Double-decrement bug**: `remainingStock` is decremented in BOTH `confirmRedemption()` (webhook, step 5a) AND here (QR scan completion). Each successful redemption → 2 decrements → stock counter becomes inaccurate.

Response: `{ success, voucherId, voucherTitle, merchantName, usedAt, scannedByAdminId, slotCompleted }`

---

## Flow 3: Merchant + Voucher Creation

### Create Merchant
```
POST /api/admin/merchants   → requireManager
Body: { name, description?, categoryId, logoUrl? }
```
Simple DB insert. No complex logic. Merchant is active by default.

### Create Voucher (with Slot + QR Scaffolding)
```
POST /api/admin/vouchers   → requireAdmin (⚠️ no role guard)
Body: { merchantId, title, description?, startDate, expiryDate, totalStock, basePrice, qrPerSlot?: 1|2 }
```

Handler (`src/routes/admin/vouchers.ts:84`):
1. Fetch AppSettings (app fee rate)
2. Fetch active FeeSetting (gas fee IDR) — returns 422 if none exists
3. Calculate `totalPrice = basePrice + (basePrice × appFeeRate/100) + gasFeeAmount` (snapshot)
4. Generate `totalStock` slot objects with UUIDs
5. Generate `totalStock × qrPerSlot` QR placeholder objects
6. **BEGIN TRANSACTION**:
   - Create Voucher with fee snapshot
   - `createMany` redemption slots
   - `createMany` QR codes (with placeholder `imageUrl: "https://placeholder.qr/{id}"`)
7. Return `{ voucher, slotsCreated, qrCodesCreated }`

**Note**: QR `imageUrl` is a placeholder at creation time. Real QR images are generated only when a user redeems (via `generateQrCode()` in `initiateRedemption()`). The placeholder URLs are replaced at that point.

### Logo Upload
```
POST /api/admin/upload/logo  → requireManager
Body: multipart/form-data, field "file" or "logo"
```
- Validates: max 5MB, image MIME type
- Generates UUID filename
- Uploads to `wealth-merchant-logos` R2 bucket (public)
- Returns public URL via `getPublicUrl(key)` which uses `R2_LOGO_PUBLIC_URL` env

---

## Flow 4: Price Fetching

```
GET /api/price/wealth
```

`getWealthPrice()` (`src/services/price.ts:67`):
1. Check module-level `cachedPrice` (TTL: 60s) — return if fresh
2. Fetch `CMC_API_KEY` from env — throw if missing
3. **Parallel fetch**:
   - CMC: `GET /v2/cryptocurrency/quotes/latest?slug={WEALTH_CMC_SLUG}&convert=USD`
   - FX: `GET /v6/latest/USD` (cached 15min separately)
4. `priceIdr = priceUsd × usdToIdr`
5. Cache result
6. If any fetch fails but stale cache exists → return `{ ..., stale: true }`

**Polling strategy**: No server-side polling. Price is fetched on demand (each API call), with a 60-second cache preventing CMC rate limit issues. In serverless, this cache is per-instance (no sharing).

**FX rate**: Fetched from `open.er-api.com` (free, no API key). Cached 15 minutes.

---

## Flow 5: Admin Authentication

```
1. POST /api/auth/check-email
   → { needs_password_setup: bool }
   
2a. First login:
    POST /api/auth/set-password
    Body: { email, password (min 8), confirmPassword }
    → bcrypt.hash(password, 12) → update admin.passwordHash
    
2b. Returning:
    POST /api/auth/login
    Body: { email, password }
    → bcrypt.compare(password, admin.passwordHash)
    → createAdminToken({ id, email, role }) → signed JWT 24h
    → Response: { token, admin: { id, email, role, isActive, createdAt, updatedAt } }
    
3. All requests:
   Authorization: Bearer {token}
   requireAdmin → jose.jwtVerify → prisma.admin.findUnique (live DB check)
```

Password reset by owner: `POST /api/admin/admins/:id/reset-password` → sets `passwordHash = null` → next login triggers first-login flow.
