---
date: 2026-04-14
topic: backend-alignment-to-brief
status: active
---

# WEALTH Backend — Alignment ke Brief, DB Schema & Backend Flow

## Executive Summary

Perbandingan antara **docs/** (brief, db schema, backend flow) dan implementasi aktual
di **backend/** menemukan tiga kelas masalah:

1. **Schema kritis hilang** — tabel `redemption_slots` tidak ada; voucher tidak punya
   fee snapshot; soft delete tidak diimplementasikan di semua entitas utama
2. **Business logic salah** — voucher dibuat tanpa generate slot/QR; role-permission
   matrix tidak sesuai brief; QR status naming berbeda; edit stok tanpa floor constraint
3. **Endpoint dan field hilang** — beberapa endpoint di brief belum ada;
   `AppSettings` punya field dengan nama dan tipe yang salah

Pekerjaan ini adalah **Phase 1 backend completion** — menyeselesaikan semua yang harus
berfungsi sebelum back-office bisa digunakan dan sebelum Phase 2 (user app) dimulai.

Dasar alignment: `docs/1-project-brief.md`, `docs/2-database-schema.md`,
`docs/3-backend-flow.md`, `docs/4-comparison.md`.

---

## 1. Dasar — Brief, DB Schema & Backend Flow sebagai Source of Truth

### 1.1 Prinsip Utama dari Docs

**Soft Delete adalah mandatory di semua entitas utama:**
- `admins`, `merchants`, `vouchers` harus punya kolom `deleted_at timestamptz NULL`
- Operasi "hapus" = set `deleted_at`, tidak pernah `DELETE` dari DB
- Query semua list endpoint harus filter `deleted_at IS NULL`

**Redemption Slot adalah core concept:**
- Satu voucher → N slot (N = `total_stock`)
- Satu slot = satu unit yang bisa di-redeem oleh satu user
- Satu slot → 1 atau 2 QR code (`qr_per_slot` di voucher)
- Slot dan QR harus di-generate serentak saat voucher dibuat

**Fee Snapshot — pricing immutable per voucher:**
```
total_price = base_price + (base_price × app_fee_rate%) + gas_fee_amount
```
- `app_fee_rate` dari `system_config` → snapshot ke `vouchers.app_fee_rate` saat buat
- `gas_fee_amount` dari `fee_settings WHERE is_active = true` → snapshot ke `vouchers.gas_fee_amount`
- Perubahan fee global tidak mempengaruhi voucher yang sudah dibuat
- `base_price`, `app_fee_rate`, `gas_fee_amount`, `total_price` — tidak bisa diedit setelah buat

**QR Status Flow (dari schema):**
```
QR Code:  available → redeemed → used
Slot:     available → redeemed → fully_used
```
- Konten QR yang di-encode = UUID `id` dari row `qr_codes` (bukan field terpisah)
- Saat user redeem slot: semua QR dalam slot berubah ke `redeemed` secara atomik
- Saat admin scan 1 QR: QR itu jadi `used`; jika semua QR dalam slot `used` → slot jadi `fully_used`
- `remaining_stock` berkurang saat slot jadi `fully_used`

**Role-Permission Matrix (dari brief):**

| Aksi | Owner | Manager | Admin |
|---|---|---|---|
| Kelola accounts (CRUD) | ✅ | ❌ | ❌ |
| Set App Fee & System Config | ✅ | ❌ | ❌ |
| Merchant CRUD | ❌ | ✅ | ❌ |
| Fee Settings CRUD + Activate | ❌ | ✅ | ❌ |
| Voucher CRUD | ❌ | ✅ all | ✅ assigned merchant only |
| Scan QR | ❌ | ❌ | ✅ assigned merchant only |
| List Merchants | ❌ | ✅ all | ✅ assigned only |
| List Vouchers | ❌ | ✅ all | ✅ assigned only |

### 1.2 Field Naming yang Benar (Docs vs Backend Sekarang)

| Konsep | Docs (Benar) | Backend (Salah) |
|---|---|---|
| Tanggal expired voucher | `expiry_date` | `end_date` |
| Jumlah QR per slot | `qr_per_slot` | `qr_per_redemption` |
| Status QR setelah user redeem | `redeemed` | `assigned` |
| Harga dasar voucher | `base_price` (Decimal) | `price_idr` (Int) |
| App fee | `app_fee_rate` | `app_fee_percentage` |
| Contract $WEALTH | `wealth_contract_address` | `token_contract_address` |
| Wallet dev | `dev_wallet_address` | `treasury_wallet_address` |

---

## 2. Hasil Comparison — Apa yang Salah

### 2.1 Schema / Prisma

| Gap | Severity |
|---|---|
| `redemption_slots` table tidak ada sama sekali | 🔴 Kritis |
| `deleted_at` tidak ada di `Admin`, `Merchant`, `Voucher` | 🔴 Kritis |
| `Voucher` tidak punya `base_price`, `app_fee_rate`, `gas_fee_amount`, `total_price` | 🔴 Kritis |
| `Voucher` punya `priceIdr` (Int) bukan `basePrice` (Decimal) | 🔴 Kritis |
| `Voucher.endDate` seharusnya `expiryDate` | 🟡 Penting |
| `Voucher.qrPerRedemption` seharusnya `qrPerSlot` | 🟡 Penting |
| `QrCode` tidak punya `slotId`, `qrNumber`, `redeemedAt` | 🔴 Kritis (terkait slot) |
| `QrCode.status` enum: `assigned` seharusnya `redeemed` | 🟡 Penting |
| `QrCode` punya `token`, `imageUrl`, `imageHash` — tidak ada di docs | 🟠 Perlu keputusan |
| `AppSettings` punya nama field salah (lihat §1.2) | 🟡 Penting |
| `AppSettings` tidak punya `alchemyRpcUrl`, `coingeckoApiKey`, audit fields | 🟡 Penting |
| `FeeSetting.amountIdr` adalah `Int` seharusnya `Decimal(15,2)` | 🟡 Minor |
| `Admin` tidak punya `createdBy`, `deletedAt` | 🔴 Kritis (soft delete) |
| `Merchant` pakai `categoryId` FK ke tabel `Category`, bukan enum | 🟠 Perlu keputusan |
| Partial unique index `admins_merchant_unique` tidak ada | 🟡 Penting |
| `Admin` tidak punya `createdBy` FK | 🟡 Minor |

### 2.2 Business Logic

| Gap | Severity |
|---|---|
| Voucher creation tidak generate slot atau QR — core flow rusak | 🔴 Kritis |
| Voucher creation tidak snapshot fee — pricing tidak akurat | 🔴 Kritis |
| Semua delete adalah hard delete — data hilang permanen | 🔴 Kritis |
| QR scan: `remaining_stock` tidak berkurang saat slot jadi `fully_used` | 🔴 Kritis |
| First-login response: 403 + code vs docs: 200 + `needs_password_setup: true` | 🟡 Penting |
| Fee activate/delete: dikunci ke `requireOwner` seharusnya `requireManager` | 🟡 Penting |
| Merchant delete: dikunci ke `requireOwner` seharusnya `requireManager` | 🟡 Penting |
| Voucher delete: dikunci ke `requireOwner` seharusnya Manager + Admin | 🟡 Penting |
| Edit stok voucher tidak ada floor constraint dan tidak ada slot management | 🟡 Penting |
| Admin list tidak ada filter (role, is_active, search, pagination) | 🟡 Penting |
| Merchant list: admin role tidak auto-filter ke assigned merchant | 🟡 Penting |
| `reset-password` endpoint tidak ada | 🟡 Penting |
| `change-password` endpoint tidak ada | 🟡 Penting |
| Partial unique admin-merchant tidak di-enforce di DB | 🟡 Penting |

### 2.3 Endpoint Hilang / Salah

| Endpoint | Status | Catatan |
|---|---|---|
| `GET /admin/admins` — filter + pagination | ❌ Hilang | Hanya ada list tanpa filter |
| `GET /admin/admins/:id` | ❌ Hilang | Detail per account |
| `POST /admin/admins/:id/reset-password` | ❌ Hilang | Owner reset password admin lain |
| `PATCH /auth/change-password` | ❌ Hilang | Self-service ganti password |
| `GET /admin/merchants/:id` | ❌ Hilang | Detail per merchant |
| `GET /admin/merchants/select` | ❌ Hilang | Dropdown untuk assign admin (Owner) |
| `GET /admin/settings` | ⚠️ Field hilang | `alchemyRpcUrl`, `coingeckoApiKey` tidak ada |
| `POST /admin/fee-settings/:id/activate` | ⚠️ Guard salah | Harus Manager, bukan Owner |
| `DELETE /admin/fee-settings/:id` | ⚠️ Guard salah | Harus Manager, bukan Owner |
| `DELETE /admin/merchants/:id` | ⚠️ Guard salah + hard delete | Harus Manager, soft delete |
| `DELETE /admin/vouchers/:id` | ⚠️ Guard salah + hard delete | Harus Manager+Admin, soft delete |

### 2.4 Yang Tidak Bermasalah (Sesuai atau Cukup)

- Auth login, set-password, me → OK (kecuali first-login response format minor)
- Admin PUT (update isActive + merchantId) → sudah benar
- Fee settings GET, POST, PUT → benar
- Merchant GET list (filter, pagination, search) → OK (kecuali admin role auto-filter)
- Merchant POST → benar
- Merchant PUT → benar
- Voucher GET list, GET detail → benar
- Analytics semua endpoint → OK (data akan lebih akurat setelah slot/QR fix)
- QR GET list → OK
- Upload endpoint → OK
- Webhook → OK
- Public price endpoint → OK

---

## 3. Perubahan yang Dibutuhkan

### Group A — Schema Kritis (Database Migration)

**A1: Soft Delete — tambah `deletedAt` ke Admin, Merchant, Voucher**

Prisma migration: tambah `deletedAt DateTime? @map("deleted_at")` di ketiga model.
Semua query `findMany` dan `findUnique` harus tambah `where: { deletedAt: null }`.
Semua delete endpoint harus ganti `prisma.*.delete()` ke `prisma.*.update({ data: { deletedAt: new Date() } })`.

**A2: Tambah tabel `redemption_slots`**

Model baru di Prisma:
- `id`, `voucherId` (FK), `slotIndex` (Int), `status` (enum: available/redeemed/fully_used),
  `redeemedAt`, `createdAt`, `updatedAt`
- Unique constraint: `(voucherId, slotIndex)`
- Enum baru `SlotStatus`

**A3: Rombak tabel `vouchers` — fee snapshot fields**

Tambah ke model `Voucher`:
- `basePrice Decimal @db.Decimal(15,2)` — rename dari `priceIdr` (Int)
- `appFeeRate Decimal @db.Decimal(5,2)` — snapshot
- `gasFeeFeeAmount Decimal @db.Decimal(15,2)` — snapshot
- `totalPrice Decimal @db.Decimal(15,2)` — calculated + stored
- `createdBy String? @map("created_by")` FK → admins

Rename:
- `endDate` → `expiryDate`
- `qrPerRedemption` → `qrPerSlot`

Hapus: `priceIdr` (diganti `basePrice`)

**A4: Rombak tabel `qr_codes` — tambah slot relationship**

Tambah ke model `QrCode`:
- `slotId String @map("slot_id")` FK → redemption_slots
- `qrNumber Int @map("qr_number")` — posisi QR dalam slot (1 atau 2)
- `redeemedAt DateTime? @map("redeemed_at")` — diisi saat slot di-redeem

Ganti enum `QrStatus.assigned` → `redeemed`

Pertahankan `token` field — diperlukan untuk QR scan endpoint (token = UUID id yang di-encode ke QR). Field `imageUrl` dan `imageHash` dipertahankan sementara untuk backward compat; deprecation didokumentasikan.

**A5: Rombak `AppSettings` — rename + tambah field**

Rename fields:
- `appFeePercentage` → `appFeeRate`
- `tokenContractAddress` → `wealthContractAddress`
- `treasuryWalletAddress` → `devWalletAddress`

Tambah:
- `alchemyRpcUrl String? @map("alchemy_rpc_url")`
- `coingeckoApiKey String? @map("coingecko_api_key")`
- `appFeeUpdatedBy String? @map("app_fee_updated_by")` FK → admins
- `appFeeUpdatedAt DateTime? @map("app_fee_updated_at")`

**A6: Fix `FeeSetting.amountIdr` → Decimal**

Ganti `amountIdr Int` → `amountIdr Decimal @db.Decimal(15,2)`

**A7: Tambah partial unique index admin-merchant**

Di Prisma schema `Admin`:
```
@@unique([merchantId], name: "admins_merchant_unique", map: "admins_merchant_unique")
```
Catatan: Prisma tidak mendukung partial unique index secara native — gunakan raw SQL migration + DB constraint. Perlu `@@ignore` atau workaround.

**A8: Tambah `Admin.createdBy`**

Tambah `createdBy String? @map("created_by")` FK → admins.

---

### Group B — Business Logic Fixes

**B1: Voucher creation — atomic slot + QR generation**

Saat `POST /admin/vouchers`:
1. Ambil `system_config.app_fee_rate` → snapshot ke `vouchers.appFeeRate`
2. Ambil `fee_settings WHERE is_active = true` → snapshot `amountIdr` ke `vouchers.gasFeeFeeAmount`
3. Hitung: `totalPrice = basePrice + (basePrice × appFeeRate / 100) + gasFeeAmount` (Decimal, ROUND_HALF_UP 2dp)
4. Buat row `voucher` dengan semua field snapshot
5. Buat `totalStock` baris `redemption_slot` (slotIndex 1..N)
6. Untuk setiap slot: buat `qrPerSlot` baris `qr_code` (qrNumber 1..M)
7. Semua operasi dalam 1 Prisma `$transaction`

Validasi tambahan: harus ada active fee setting sebelum bisa buat voucher → error 422 `NO_ACTIVE_FEE`.

**B2: Voucher edit stok — floor constraint + slot management**

Saat `PUT /admin/vouchers/:id`:
- Jika `totalStock` naik: generate slot + QR baru (dari `currentTotal+1` sampai `newTotal`)
- Jika `totalStock` turun:
  - Floor = count slot dengan status `redeemed` atau `fully_used`
  - Error 422 jika `newStock < floor`
  - Hapus slot AVAILABLE dari belakang (`slotIndex DESC LIMIT (current - new)`)
  - Hapus QR codes dari slot yang dihapus
- Dalam 1 `$transaction`

**B3: QR scan — fix slot completion + remaining_stock**

Saat `POST /admin/qr-codes/scan` berhasil (QR dari `redeemed` → `used`):
1. Set `qr_code.status = used`, `qr_code.usedAt = now()`, `qr_code.scannedByAdminId`
2. Cek: apakah semua QR dalam slot yang sama sudah `used`?
3. Jika ya: set `redemption_slot.status = fully_used`
4. Dan: decrement `voucher.remainingStock -= 1`
5. Semua dalam 1 `$transaction`

**B4: Soft delete — semua entitas**

Setiap delete route:
- Ganti `prisma.*.delete()` ke `prisma.*.update({ data: { deletedAt: new Date() } })`
- Validasi: voucher tidak bisa soft delete jika ada QR berstatus `redeemed` atau `used`
  → error 422 `VOUCHER_HAS_ACTIVE_QR`
- Merchant soft delete: cascade semua voucher → soft delete juga? → **tidak**: voucher
  tetap ada di DB, hanya tidak tampil ke user (karena merchant.isActive = false)

**B5: Fix role-permission matrix**

- `fee-settings/:id/activate`: ganti `requireOwner` → `requireManager`
- `fee-settings/:id` DELETE: ganti `requireOwner` → `requireManager`
- `merchants/:id` DELETE: ganti `requireOwner` → `requireManager` + soft delete
- `vouchers/:id` DELETE: hapus `requireOwner`, tambah middleware yang allow manager + admin (merchant-scoped untuk admin)

**B6: Admin list — tambah filter, pagination, dan auto-filter**

`GET /admin/admins` tambahkan:
- Query params: `?role=admin|manager|owner`, `?isActive=true|false`, `?search=email`, `?page=1&limit=20`
- Response: tambah `pagination` object (page, limit, total, totalPages)

`GET /admin/merchants` — admin role fix:
- Tambah auto-filter `WHERE merchant_id = adminAuth.merchantId` untuk role `admin`

---

### Group C — Endpoint Baru

**C1: `GET /admin/admins/:id`**

Detail satu admin berdasarkan ID. Butuh untuk front-end profile view. Owner only.
Response sama dengan list tapi single object.

**C2: `POST /admin/admins/:id/reset-password`**

Owner set `passwordHash = null` untuk admin lain. Admin langsung tidak bisa login
sampai set password baru via first-login flow.
- Guard: owner only
- Validasi: tidak bisa reset diri sendiri
- Tidak bisa reset last active owner

**C3: `PATCH /auth/change-password`**

Self-service ganti password. Butuh `currentPassword` + `newPassword`.
- Verifikasi `currentPassword` vs hash
- Hash `newPassword` → simpan
- Response 200 success

**C4: `GET /admin/merchants/:id`**

Detail satu merchant. Manager + Admin (merchant-scoped untuk admin).
Include: nama, logo, deskripsi, kategori, status, jumlah voucher aktif.

**C5: `GET /admin/merchants/select`**

Dropdown list untuk assign admin. Owner only.
Response: `[{ id, name }]` tanpa pagination — untuk select input.
Filter: aktif saja + belum punya admin aktif (unassigned merchants).

**C6: Fix first-login response**

Saat `POST /auth/login` dengan `passwordHash = null`:
Ganti dari `403 { error, code: "PASSWORD_NOT_SET" }` ke
`200 { needs_password_setup: true, email: "..." }`.

Dampak: front-end back-office sudah handle 403 workaround — perlu dicocokan saat fix ini diimplementasikan.

---

### Group D — Settings API Update

**D1: Update `GET /admin/settings` dan `PUT /admin/settings`**

- Tambah field `alchemyRpcUrl`, `coingeckoApiKey` ke response dan update payload
- Rename semua field yang salah (sesuai §1.2 naming table)
- Tambah `appFeeUpdatedBy`, `appFeeUpdatedAt` di response

---

### Yang Tidak Masuk Scope (Defer)

| Item | Alasan Defer |
|---|---|
| `POST /auth/logout` session invalidation | Low priority Phase 1; per-request DB check cukup untuk sekarang |
| `POST /auth/refresh` token refresh | Tidak kritis; token lifetime bisa diperpanjang |
| Alchemy integration (wallet balance realtime) | Perlu config + external API testing |
| `GET /vouchers/:id/slots` endpoint | Phase 2 feature (user app perlu lihat slot) |
| `GET /qr/:uuid` detail endpoint | Phase 2 |
| PUT → PATCH HTTP method changes | Breaking change tanpa manfaat bisnis langsung |
| Tabel `Category` → enum `merchant_category` | Table sudah ada dan berfungsi; enum hanya architectural preference di docs |
| Phase 2 redemption flow (Privy, transactions) | Scope Phase 2 |

---

## 4. Strategi Clearing & Naming Convention

### 4.1 Urutan Pengerjaan

```
Phase 1: Schema Migration (A1–A8)
    ↓ Prisma migration, test DB teardown/recreate
Phase 2: Business Logic Core (B1–B5)
    ↓ Voucher creation flow jalan, QR bisa di-scan
Phase 3: Endpoint Fixes (B6, C1–C6, D1)
    ↓ Semua CRUD endpoint sesuai brief
Phase 4: Test Suite Update
    ↓ Coverage semua kasus baru + fix test lama yang rusak
```

Setiap phase bisa di-commit dan dideploy ke staging secara independen.

### 4.2 Naming Convention — Standard yang Digunakan

Semua nama harus konsisten dengan `docs/2-database-schema.md`. Berlaku untuk:
- Prisma model field names (camelCase di code, snake_case di `@map`)
- API response field names (camelCase, sesuai Prisma output)
- Zod schema keys
- Test assertion keys

**Field mapping (Prisma camelCase → snake_case DB):**

| Konsep | Prisma Field (Benar) | Yang Salah (hapus) |
|---|---|---|
| Harga dasar voucher | `basePrice` (`base_price`) | ~~`priceIdr`~~ |
| Tanggal expired | `expiryDate` (`expiry_date`) | ~~`endDate`~~ |
| QR per slot | `qrPerSlot` (`qr_per_slot`) | ~~`qrPerRedemption`~~ |
| Status QR setelah redeem | `redeemed` (enum) | ~~`assigned`~~ |
| App fee config | `appFeeRate` (`app_fee_rate`) | ~~`appFeePercentage`~~ |
| Contract address | `wealthContractAddress` | ~~`tokenContractAddress`~~ |
| Dev wallet | `devWalletAddress` | ~~`treasuryWalletAddress`~~ |
| Config RPC | `alchemyRpcUrl` | ~~tidak ada~~ |
| Config price feed | `coingeckoApiKey` | ~~tidak ada~~ |
| Fee gas amount | `gasFeeAmount` (`gas_fee_amount`) | ~~`gasFeeFeeAmount`~~ (koreksi typo) |

**Enum naming:**
```
SlotStatus  : available | redeemed | fully_used
QrStatus    : available | redeemed | used         ← fix "assigned" → "redeemed"
AdminRole   : owner | manager | admin             (unchanged, OK)
```

**Route naming:**
```
/admin/admins/:id/reset-password    POST  (baru)
/auth/change-password               PATCH (baru)
/admin/merchants/:id                GET   (baru)
/admin/merchants/select             GET   (baru)
```

### 4.3 File yang Disentuh (per perubahan)

```
prisma/schema.prisma                          — A1–A8 (semua schema changes)
src/routes/admin/vouchers.ts                  — B1, B2, B5
src/routes/admin/qr-codes.ts                  — B3
src/routes/admin/admins.ts                    — B6, C1, C2
src/routes/admin/merchants.ts                 — B4 (auto-filter), B5, C4, C5
src/routes/admin/fee-settings.ts              — B5 (permission)
src/routes/admin/settings.ts                  — D1
src/routes/auth.ts                            — C3, C6
src/schemas/voucher.ts                        — B1 (schema fields rename)
src/schemas/admin.ts                          — B6, C2 (update schema)
src/schemas/merchant.ts                       — soft delete aware
src/middleware/auth.ts                        — tidak berubah (guard helper sudah ada)
```

### 4.4 Tidak Ada Mock Data untuk Dihapus

Backend tidak menggunakan mock data di production code. Test helpers di
`tests/helpers/fixtures.ts` menggunakan real Prisma insert ke test DB — ini
adalah pendekatan yang benar dan tidak perlu diganti.

Yang perlu di-update setelah schema changes:
- `tests/helpers/fixtures.ts` — update `createVoucher`, `createMerchant`, `createAdmin`
  fixtures agar sesuai schema baru (field names, required fields)
- `tests/setup.integration.ts` — tambah cleanup untuk tabel `redemption_slots` baru
- Test yang existing yang testing field lama (endDate, priceIdr, dll) perlu diupdate

### 4.5 Migration Strategy

- Ini development/staging environment — tidak ada production data
- Satu migration besar untuk semua schema changes (lebih bersih daripada 8 migration kecil)
- Atau: 3 migration group: (1) tambah tabel baru + kolom baru, (2) rename + type changes, (3) constraints
- Setelah migration: `prisma db push` atau `prisma migrate dev`
- `tests/setup.integration.ts` perlu tambah `testPrisma.redemptionSlot.deleteMany()` di `beforeEach`

---

## 5. Testing Strategy

### 5.1 Pendekatan — Backend + Real Database

Backend adalah pure API server (Hono + Prisma + PostgreSQL). Strategi testing:

> _Test setiap endpoint dari sudut pandang HTTP client — verifikasi status code,
> response body shape, dan DB state setelah operasi._

**Setup yang sudah ada (pertahankan):**
- Real PostgreSQL test database via `DATABASE_URL`
- `tests/setup.integration.ts` — clean semua tabel di `beforeEach`
- `tests/helpers/fixtures.ts` — factory functions untuk buat data test
- `tests/helpers/auth.ts` — generate JWT token per role
- `tests/helpers/request.ts` — helper HTTP client (jsonPost, authGet, dll)
- `vitest-mock-extended` untuk unit test schema + service

**Prinsip tambahan:**
- Setiap test harus `async` dan bersih — tidak bergantung pada urutan test
- Test DB state setelah mutasi, tidak hanya response code
- Setiap protected route harus punya test untuk semua role yang tidak berhak (401, 403)
- Operasi atomik (fee activation, slot generation) harus diverifikasi di DB

### 5.2 Layer 1 — Unit Test (Vitest, tanpa DB)

Target: fungsi pure yang tidak butuh DB atau HTTP.

| Fungsi | File | Target |
|---|---|---|
| Hitung total price voucher | `src/services/pricing.ts` (baru) | `calcTotalPrice(basePrice, feeRate, gasAmount)` |
| Validasi format UUID | `src/schemas/qr.ts` | UUID regex validation |
| Zod schemas semua routes | `tests/unit/schemas/` | valid, invalid, edge cases |

**Test cases Layer 1:**

*Pricing calculation:*
```
calcTotalPrice(50000, 3, 500) → 52000.00
calcTotalPrice(100000, 0, 0)  → 100000.00
calcTotalPrice(10000, 10, 2000) → 13000.00
calcTotalPrice(1000, 3, 500)  → 1530.00   (minimum valid base price)
calcTotalPrice(50000, 3.5, 500) → Rounding test (ROUND_HALF_UP)
```

*Zod schema validation:*
```
createVoucherSchema: valid, expiryDate < startDate (fail), totalStock=0 (fail),
                     basePrice < 1000 (fail), qrPerSlot=3 (fail)
createAdminSchema: valid email+role, invalid email (fail)
updateVoucherSchema: read-only fields di-ignore (tidak error)
```

### 5.3 Layer 2 — Integration Test (Real DB)

**Pattern per endpoint:**
```typescript
describe("POST /api/admin/vouchers", () => {
  test("creates voucher with fee snapshot and generates slots and QRs", async () => {
    // Setup: create active fee setting + system config
    // POST voucher
    // Assert: response 201 + correct fields
    // Assert DB: redemption_slots count = totalStock
    // Assert DB: qr_codes count = totalStock × qrPerSlot
    // Assert DB: voucher.appFeeRate matches system_config snapshot
  });

  test("returns 422 NO_ACTIVE_FEE when no active fee exists", async () => {
    // ...
  });
});
```

#### Auth Flow

| Case | Type | Expected |
|---|---|---|
| Login sukses → JWT + admin object | Positive | 200 `{ token, admin }` |
| Login first-login (passwordHash null) → `needs_password_setup` | Positive | 200 `{ needs_password_setup: true, email }` |
| Login password salah | Negative | 401 |
| Login akun nonaktif | Negative | 401 |
| Login email tidak terdaftar | Negative | 401 |
| Set password sukses | Positive | 200 |
| Set password dengan password yang sudah ada | Negative | 409 |
| Set password < 8 karakter | Negative | 400 |
| Change password sukses | Positive | 200 |
| Change password current_password salah | Negative | 401 |
| Change password tanpa auth | Negative | 401 |

#### Admins (Owner Only)

| Case | Type | Expected |
|---|---|---|
| List admins → array | Positive | 200 `{ admins, pagination }` |
| List admins dengan filter `?role=admin` | Positive | 200 filtered |
| List admins dengan `?search=email@` | Positive | 200 filtered |
| List admins sebagai manager | Negative | 403 |
| Create admin role=admin + merchantId | Positive | 201 |
| Create admin role=admin tanpa merchantId | Positive | 201 (merchantId null) |
| Create admin email duplikat | Negative | 400 |
| Create admin sebagai non-owner | Negative | 403 |
| Update admin `isActive=false` | Positive | 200 |
| Update admin `merchantId` untuk role selain admin | Negative | 400 |
| Update admin tidak ditemukan | Negative | 404 |
| Soft delete admin | Positive | 200 `{ ok: true }`, admin `deletedAt` terisi |
| Hard delete (seharusnya tidak terjadi) | Edge | DB `deletedAt IS NOT NULL`, bukan terhapus |
| Delete last owner | Negative | 400 |
| Delete diri sendiri | Negative | 400 |
| Reset password admin lain | Positive | 200, `passwordHash` jadi null |
| Reset password diri sendiri | Negative | 400 |

#### Fee Settings (Manager)

| Case | Type | Expected |
|---|---|---|
| List fee settings | Positive | 200 `{ feeSettings }` |
| Buat fee setting | Positive | 201, `isActive=false` default |
| Buat fee dengan `amountIdr = 0` | Negative | 400 |
| Buat fee sebagai admin (bukan manager) | Negative | 403 |
| Aktifkan fee → semua lain jadi tidak aktif | Positive | 200, DB: hanya 1 aktif |
| Aktifkan fee sebagai owner (bukan manager) | Negative | 403 |
| Aktifkan fee yang tidak ada | Negative | 404 |
| Hapus fee nonaktif | Positive | 200 |
| Hapus fee yang aktif | Negative | 400 `Cannot delete active fee` |
| Hapus fee sebagai owner | Negative | 403 |

#### Merchants (Manager / Admin scoped)

| Case | Type | Expected |
|---|---|---|
| List merchant sebagai manager → semua | Positive | 200 all |
| List merchant sebagai admin → hanya assigned | Positive | 200 filtered |
| List merchant soft-deleted tidak muncul | Edge | soft deleted tidak tampil |
| GET merchant by ID sebagai manager | Positive | 200 |
| GET merchant by ID sebagai admin (bukan assigned) | Negative | 403 |
| GET merchant by ID tidak ada | Negative | 404 |
| GET /merchants/select sebagai owner → unassigned list | Positive | 200 `[{ id, name }]` |
| Buat merchant (manager) | Positive | 201 |
| Buat merchant sebagai admin | Negative | 403 |
| Edit merchant (manager) | Positive | 200 |
| Soft delete merchant (manager) → `deletedAt` terisi | Positive | 200 |
| Soft delete merchant sebagai owner | Negative | 403 |
| Soft delete merchant yang sudah dihapus | Negative | 404 |

#### Vouchers (Manager + Admin scoped)

| Case | Type | Expected |
|---|---|---|
| Create voucher valid → 201 + slots + QRs di-generate | Positive | 201, DB check |
| Create voucher → appFeeRate snapshot benar | Positive | DB appFeeRate = system_config value |
| Create voucher → gasFeeAmount snapshot dari active fee | Positive | DB gasFeeAmount = feeSetting.amountIdr |
| Create voucher tanpa active fee setting | Negative | 422 `NO_ACTIVE_FEE` |
| Create voucher `expiryDate < startDate` | Negative | 400 |
| Create voucher `totalStock = 0` | Negative | 400 |
| Create voucher `basePrice < 1000` | Negative | 400 |
| Create voucher `qrPerSlot = 2` → 2× QR per slot | Positive | DB: totalStock×2 QR codes |
| Create voucher sebagai admin → merchantId auto ke assigned | Positive | 201 |
| Edit voucher: naik stok → generate slot+QR baru | Positive | DB: new slots/QRs |
| Edit voucher: turun stok di atas floor | Positive | 200, slots AVAILABLE dihapus |
| Edit voucher: turun stok di bawah floor | Negative | 422 `BELOW_FLOOR` |
| Edit voucher: ubah `basePrice` (immutable) → di-ignore | Edge | 200, basePrice tidak berubah |
| List voucher sebagai admin → hanya assigned merchant | Positive | filtered |
| Soft delete voucher tanpa QR aktif | Positive | 200 |
| Soft delete voucher yang punya QR redeemed | Negative | 422 `VOUCHER_HAS_ACTIVE_QR` |
| Soft delete sebagai owner | Negative | 403 |

#### QR Scan (Admin Only)

| Case | Type | Expected |
|---|---|---|
| Scan UUID valid, QR status `redeemed` → jadi `used` | Positive | 200 |
| Scan → semua QR slot jadi used → slot jadi `fully_used` | Integration | DB: slot status |
| Scan → slot `fully_used` → `remaining_stock` berkurang | Integration | DB: voucher.remainingStock |
| Scan QR tidak ditemukan | Negative | 404 |
| Scan QR bukan milik merchant admin | Negative | 403 |
| Scan QR status `available` (belum di-redeem) | Negative | 422 `QR_NOT_REDEEMED` |
| Scan QR status `used` | Negative | 409 `QR_ALREADY_USED` |
| Scan sebagai manager (bukan admin) | Negative | 403 |
| Input bukan UUID format valid | Negative | 400 |

#### System Config (Owner Only)

| Case | Type | Expected |
|---|---|---|
| GET settings → semua field termasuk alchemyRpcUrl | Positive | 200 |
| Update appFeeRate | Positive | 200, `appFeeUpdatedAt` diisi |
| Update alchemyRpcUrl | Positive | 200 |
| Update appFeeRate > 50 | Negative | 400 |
| Update appFeeRate < 0 | Negative | 400 |
| Update sebagai manager | Negative | 403 |
| Update devWalletAddress format salah (bukan 0x+40hex) | Negative | 400 |

### 5.4 Layer 3 — E2E / Smoke Test

Dijalankan satu kali sebelum deploy ke staging (bukan di CI per commit).
Script ada di `tests/e2e/` dan butuh backend hidup.

**Scenario 1 — Full Voucher Lifecycle:**
1. Buat voucher (dengan active fee) → verify slot + QR terbuat di DB
2. Set QR ke `redeemed` via DB direct (simulasi Phase 2 user redeem)
3. Admin scan QR → verify QR `used`, slot `fully_used`, `remaining_stock` berkurang

**Scenario 2 — Role Isolation:**
1. Login sebagai admin (assigned ke merchant X)
2. Try GET merchant Y → 403
3. Try GET voucher bukan merchant X → 403
4. Try fee activate → 403
5. Login sebagai manager → fee activate sukses

**Scenario 3 — Soft Delete:**
1. Buat merchant + voucher
2. Soft delete merchant
3. Verify merchant masih di DB tapi `deletedAt` terisi
4. Verify merchant tidak muncul di list
5. Verify voucher masih ada

---

## 6. Success Criteria

Pekerjaan ini selesai ketika:

- [ ] Prisma schema punya `redemption_slots` model dengan constraint yang benar
- [ ] `Admin`, `Merchant`, `Voucher` punya `deleted_at` dan tidak ada hard delete
- [ ] Voucher creation: generate slot + QR + fee snapshot atomik dalam 1 transaction
- [ ] QR scan: saat slot `fully_used`, `remaining_stock` berkurang
- [ ] `fee-settings activate/delete` bisa diakses Manager
- [ ] `merchants delete` bisa diakses Manager (soft delete)
- [ ] `vouchers delete` bisa diakses Manager + Admin (soft delete)
- [ ] `AppSettings` punya field lengkap sesuai schema docs
- [ ] `GET /admin/admins` ada pagination dan filter
- [ ] `POST /admin/admins/:id/reset-password` ada
- [ ] `GET /admin/merchants/:id` ada
- [ ] `GET /admin/merchants/select` ada (owner only)
- [ ] `PATCH /auth/change-password` ada
- [ ] First-login response: 200 `{ needs_password_setup: true }` bukan 403
- [ ] Semua unit test Layer 1 lulus
- [ ] Semua integration test Layer 2 lulus — positif, negatif, edge case tercakup
- [ ] `pnpm tsc --noEmit` lulus 0 error
- [ ] Lint lulus 0 error

---

## 7. Yang Tidak Berubah

- Test infrastructure (`setup.integration.ts`, helper pattern) — hanya extend
- Middleware auth stack (`requireAdmin`, `requireOwner`, `requireManager`)
- Rate limiting dan CORS config
- Upload endpoint (`/admin/upload`)
- Analytics endpoints (sudah benar, data akan membaik setelah slot fix)
- Webhook (`/api/webhook`)
- Public price endpoint (`/api/price`)
- Phase 2 stubs (redemptions, transactions, Privy auth)

---

*Dibuat: 2026-04-14*
*Dasar: `docs/1-project-brief.md`, `docs/2-database-schema.md`, `docs/3-backend-flow.md`, `docs/4-comparison.md`*
