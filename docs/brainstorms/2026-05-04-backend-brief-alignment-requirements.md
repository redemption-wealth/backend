# Backend Brief Alignment — Requirements

**Status:** Ready for planning  
**Date:** 2026-05-04  
**Source of truth:** `docs/brief/Wealth-Backend-Brief.md`  
**Scope:** Remaining gaps after auth foundation refactor (Better Auth, schema migration, admin CRUD)

---

## Context

Sesi sebelumnya sudah menyelesaikan fondasi auth:
- Better Auth + database session
- Schema fresh start (users, sessions, accounts, admins, password_setup_tokens, app_settings)
- Custom auth endpoints (sign-in, setup-password, change-password, sign-out-others)
- Admin CRUD lengkap + toggle-active + reset-password + self-protection
- Cleanup: drop fee_settings, dead AppSettings fields, qr_codes.token, categories → enum
- Seed rewrite, .env.example alignment

Dokumen ini mendefinisikan **sisa pekerjaan** yang diperlukan untuk backend sesuai brief.

---

## Grup A — Security Bug Fixes (Wajib Sebelum Mainnet)

### A1 — Webhook HMAC Verification

**File:** `src/routes/webhook.ts`

Brief §6 Bug #1: Alchemy webhook harus verifikasi HMAC-SHA256 signature sebelum memproses payload.

**Requirements:**
- Baca raw request body sebagai string (sebelum parse JSON)
- Compute HMAC-SHA256 menggunakan `ALCHEMY_WEBHOOK_SIGNING_KEY` env var
- Bandingkan dengan `x-alchemy-signature` header (constant-time comparison)
- Reject 401 jika signature tidak valid atau env var tidak tersedia
- Jika env var tidak diset di development: log warning, proses tetap jalan (dev convenience)
- Jika env var tidak diset di production: reject semua request

### A2 — Server-Side Price Validation

**Files:** `src/routes/vouchers.ts`, `src/services/redemption.ts`

Brief §3 Redemption Flow langkah 1: "Backend fetch server-side cached price (CMC). **Reject client-supplied price.**"

**Current state:** `POST /vouchers/:id/redeem` menerima `wealthPriceIdr` dari body user, lalu `initiateRedemption` pakai nilai itu langsung.

**Requirements:**
- Hapus `wealthPriceIdr` dari `redeemVoucherSchema` (Zod) dan dari route handler body
- `initiateRedemption` tidak lagi menerima `wealthPriceIdr` sebagai parameter
- Sebaliknya, fetch `getWealthPrice()` dari `src/services/price.ts` secara server-side di dalam service
- Kalau price fetch gagal dan tidak ada stale cache: return 503 ke user
- `idempotencyKey` tetap diterima dari user (unchanged)

### A3 — R2 Env Var Name Fix

**File:** `src/services/r2.ts:13`

Brief §4 External Services: env var yang benar adalah `R2_ACCOUNT_ID`.

**Current state:** `r2.ts` membaca `process.env.CLOUDFLARE_ACCOUNT_ID`.

**Requirements:**
- Ganti `CLOUDFLARE_ACCOUNT_ID` → `R2_ACCOUNT_ID` di `r2.ts`
- Pastikan konsisten dengan `.env.example` (sudah benar di sana)

---

## Grup B — Missing Endpoints

### B1 — `GET /admin/overview` (Manager)

Brief §2 Manager Endpoints: endpoint baru untuk overview page Manager.

**Response shape:**
```json
{
  "totalMerchants": 12,
  "totalVouchers": 45,
  "totalQrAvailable": 320
}
```

**Logic:**
- `totalMerchants`: count merchants WHERE `isActive = true` AND `deletedAt IS NULL`
- `totalVouchers`: count vouchers WHERE `isActive = true` AND `deletedAt IS NULL`
- `totalQrAvailable`: count qr_codes WHERE `status = 'AVAILABLE'`
- Access: `requireManagerOrAdmin` — middleware yang sudah ada di `src/middleware/auth.ts`, mengizinkan MANAGER dan OWNER (bukan role ADMIN)
- No cache diperlukan (lightweight query)

### B2 — `GET /admin/categories` (Manager)

Brief §2 Manager Endpoints: endpoint static enum list untuk kategori merchant.

**Response shape:**
```json
{
  "categories": ["kuliner", "hiburan", "event", "kesehatan", "lifestyle", "lainnya"]
}
```

**Logic:**
- Hardcoded dari `MerchantCategory` enum — tidak ada DB query
- Access: `requireAdmin` (semua role bisa akses — diperlukan oleh form merchant)

### B3 — `POST /admin/merchants/:id/toggle-active` (Manager)

Brief §2 Manager Endpoints.

**Logic:**
- Find merchant by id, check `deletedAt IS NULL`
- Toggle `isActive` (true → false, false → true)
- Return `{ merchant }` dengan state baru
- 404 kalau tidak ketemu atau sudah soft-deleted
- Access: `requireManager`

### B4 — `POST /admin/vouchers/:id/toggle-active` (Manager/Admin scoped)

Brief §2 Manager + Admin Endpoints.

**Logic:**
- Find voucher by id, check `deletedAt IS NULL`
- Admin role: cek `voucher.merchantId === adminAuth.merchantId`, else 403
- Toggle `isActive`
- Return `{ voucher }` dengan state baru
- Access: `requireManagerOrAdmin` (fungsi middleware yang sudah ada di `src/middleware/auth.ts`)

### B5 — `GET /admin/redemptions/counts` (Owner)

Brief §2 Owner Endpoints: mengganti 5 calls terpisah ke satu endpoint.

**Response shape:**
```json
{
  "all": 150,
  "confirmed": 120,
  "pending": 20,
  "failed": 10
}
```

**Logic:**
- Paralel 4 count queries: total (semua status), CONFIRMED, PENDING, FAILED
- Counts adalah **absolute totals** — tidak ada date range filter
- Access: `requireOwner`

### B6 — `GET /admin/redemptions/recent?limit=10` (Owner)

Brief §2 Owner Endpoints. Path berbeda dari `GET /admin/analytics/recent-activity` yang ada sekarang.

**Keputusan:** Hapus `recent-activity` dari analytics routes, buat endpoint baru di redemptions router.

**Query params:** `limit` (default 10, max 50)

**Response shape:**
```json
{
  "redemptions": [
    {
      "id": "...",
      "userEmail": "...",
      "status": "CONFIRMED",
      "confirmedAt": "...",
      "voucher": { "title": "...", "merchant": { "name": "..." } }
    }
  ]
}
```

**Logic:**
- `findMany WHERE status = CONFIRMED ORDER BY confirmedAt DESC LIMIT ?` (feed = completed transactions, bukan semua status)
- Include: voucher → merchant (name only)
- No date range filter — absolute recent across all time
- Access: `requireOwner`

### B7 — `GET /admin/qr-codes/counts` (Manager)

Brief §2 Manager Endpoints: mengganti 3 calls QR status terpisah.

**Response shape:**
```json
{
  "available": 320,
  "redeemed": 45,
  "used": 85
}
```

**Logic:**
- Paralel 3 count queries berdasarkan status enum
- Manager: cross-merchant (semua QR)
- Admin role via handler: filter by `voucher.merchantId = adminAuth.merchantId`
- Access: `requireManagerOrAdmin`

---

## Grup C — Business Logic Corrections

### C1 — Auto-Reconcile 30-Second Threshold

**File:** `src/routes/redemptions.ts`

Brief §3 Redemption Flow langkah 4: "Auto-reconcile via `getTransactionReceipt` saat FE poll, lazy trigger (only kalau pending > 30 detik)"

**Current state:** Reconcile dijalankan setiap kali `GET /redemptions/:id` dipanggil dengan status pending + txHash, tanpa threshold waktu.

**Requirements:**
- Hitung `ageMs = Date.now() - redemption.createdAt.getTime()`
- Trigger reconcile hanya jika `ageMs > 30_000` (30 detik)
- Kalau belum 30 detik: langsung return current state tanpa reconcile

### C2 — Treasury Balance Cache 60s

**File:** `src/routes/admin/analytics.ts` (handler `treasury-balance`)

Brief §2 Owner Dashboard: `GET /admin/analytics/treasury-balance` dengan "cache 60s".

**Requirements:**
- Simpan hasil `balanceOf` call ke module-level variable: `{ balance, tokenAddress, treasuryAddress, cachedAt }`
- Kalau `Date.now() - cachedAt < 60_000`: return cached value tanpa RPC call
- Reset cache kalau env var `WEALTH_CONTRACT_ADDRESS` atau `DEV_WALLET_ADDRESS` berubah (tidak diperlukan — env var static)
- Error case: jika RPC call gagal dan ada stale cache, return stale dengan note `"stale": true`

---

## Grup D — Access Control Alignment

### D1 — Activity Log Restricted to Owner

**File:** `src/routes/admin/redemptions.ts`

Keputusan: Activity Log (`GET /admin/redemptions`, `GET /admin/redemptions/:id`, dan `GET /admin/redemptions/counts` dari B5) adalah **Owner-only**.

**Requirements:**
- `GET /admin/redemptions` — tambah `requireOwner` middleware pada route atau router level
- `GET /admin/redemptions/:id` — same
- `GET /admin/redemptions/counts` (B5) — `requireOwner` dari awal
- `GET /admin/redemptions/recent?limit=10` (B6) — `requireOwner`

**Catatan:** Activity Log adalah **Owner-only** — endpoint ini ada di bawah "Owner Endpoints" section di brief, bukan di "Manager Endpoints". Manager tidak tercantum sebagai role yang punya akses ke full redemption log.

---

## Non-Goals / Out of Scope

- Email-based password reset (deferred per brief §1)
- Rate limiter Redis backend (in-memory acceptable, brief §7)
- Bulk actions pada admin routes
- Restore functionality setelah soft delete
- Test suite (terpisah dari scope ini)

---

## Implementation Order (Recommended)

1. **A3** — R2 env var fix (1 line, zero risk, fix sekarang)
2. **A1** — Webhook HMAC (security critical, lakukan sebelum deploy)
3. **A2** — Server-side price (security critical, needs schema change di route + service)
4. **D1** — Tighten access control di redemptions router
5. **B2** — Categories static endpoint (trivial)
6. **B1** — Overview endpoint (lightweight query)
7. **B5 + B6 + B7** — Counts + Recent endpoints (paralel, satu sesi)
8. **B3 + B4** — Toggle-active untuk merchants + vouchers
9. **C1** — 30s reconcile threshold (1 kondisi tambahan)
10. **C2** — Treasury balance cache (module-level cache pattern)
