---
title: "Hapus Snapshot Fee, Selalu Pakai Live Rate"
type: refactor
status: completed
date: 2026-05-01
origin: docs/brainstorms/2026-05-01-live-fee-rate-brainstorm.md
---

# Hapus Snapshot Fee, Selalu Pakai Live Rate

## Overview

Mengubah sistem fee voucher dari snapshot (disimpan per voucher saat dibuat) menjadi live (selalu dihitung dari `AppSettings.appFeeRate` + `FeeSetting` aktif saat API dipanggil). Tiga kolom dihapus dari tabel `vouchers`: `app_fee_rate`, `gas_fee_amount`, `total_price`.

## Problem Statement

- Voucher menyimpan snapshot fee saat dibuat (appFeeRate=3%, gasFeeAmount=5000) — perubahan settings tidak mempengaruhi voucher lama
- `initiateRedemption()` sudah pakai live rate — ada inkonsistensi antara harga yang ditampilkan dan yang sebenarnya di-charge
- Admin bingung karena update fee settings tidak langsung terlihat di daftar voucher

## Acceptance Criteria

- [x] Kolom `app_fee_rate`, `gas_fee_amount`, `total_price` dihapus dari tabel `vouchers` via Prisma migration
- [x] Backend API (`GET /api/vouchers` dan `GET /api/vouchers/:id`) menghitung `appFeeRate`, `gasFeeAmount`, `totalPrice` on-the-fly dari `AppSettings` + `FeeSetting` aktif
- [x] Backend admin API (`GET /api/admin/vouchers`) juga menghitung on-the-fly
- [x] Voucher creation (`POST /api/admin/vouchers`) tidak lagi menyimpan snapshot fee
- [x] Response shape tetap sama — frontend tidak perlu tahu bahwa field ini sekarang computed
- [x] App frontend Zod schema dan komponen tetap berfungsi tanpa perubahan breaking
- [x] Back-office types tetap kompatibel (field sudah optional)
- [x] Komentar di `updateVoucherSchema` tentang "read-only" fields diupdate
- [x] `calcTotalPrice()` di `pricing.ts` tetap ada (dipakai untuk compute on-the-fly)
- [x] Redemption flow tidak berubah (sudah pakai live rate)

## Files to Modify

| # | File | Perubahan |
|---|------|-----------|
| 1 | `backend/prisma/schema.prisma` | Hapus 3 field dari model Voucher |
| 2 | `backend/src/routes/vouchers.ts` | Inject computed fee fields ke response list & detail |
| 3 | `backend/src/routes/admin/vouchers.ts` | Hapus snapshot saat create, inject computed fee ke response list & detail |
| 4 | `backend/src/schemas/voucher.ts` | Update komentar di `updateVoucherSchema` |
| 5 | `app/src/lib/schemas/voucher.ts` | `appFeeRate`, `gasFeeAmount`, `totalPrice` tetap required (backend tetap kirim) |
| 6 | `back-office/src/types/index.ts` | Tidak perlu berubah (sudah optional) |

**Tidak ada file baru. Tidak ada dependency baru.**

## MVP

### 1. Prisma Migration — `schema.prisma`

Hapus 3 field dari model `Voucher`:

```prisma
// HAPUS baris-baris ini:
appFeeRate     Decimal   @map("app_fee_rate") @db.Decimal(5, 2)
gasFeeAmount   Decimal   @map("gas_fee_amount") @db.Decimal(15, 2)
totalPrice     Decimal   @map("total_price") @db.Decimal(15, 2)
```

Lalu jalankan:
```bash
cd backend && npx prisma migrate dev --name remove-voucher-fee-snapshot
```

### 2. Helper: Fetch Live Fee Config

Buat helper di `routes/vouchers.ts` (dan reuse di admin routes) untuk fetch live fee dan inject ke voucher response:

```ts
// backend/src/routes/vouchers.ts (atau shared helper)

import { calcTotalPrice } from "../services/pricing.js";
import { Prisma } from "@prisma/client";

async function getLiveFeeConfig() {
  const [settings, activeFee] = await Promise.all([
    prisma.appSettings.findUnique({ where: { id: "singleton" } }),
    prisma.feeSetting.findFirst({ where: { isActive: true } }),
  ]);

  const appFeeRate = settings?.appFeeRate
    ? new Prisma.Decimal(settings.appFeeRate.toString())
    : new Prisma.Decimal("3.00");

  const gasFeeAmount = activeFee
    ? new Prisma.Decimal(activeFee.amountIdr.toString())
    : new Prisma.Decimal("0");

  return { appFeeRate, gasFeeAmount };
}

function injectFeeFields(
  voucher: { basePrice: Prisma.Decimal; [key: string]: unknown },
  appFeeRate: Prisma.Decimal,
  gasFeeAmount: Prisma.Decimal,
) {
  const totalPrice = calcTotalPrice(
    new Prisma.Decimal(voucher.basePrice.toString()),
    appFeeRate,
    gasFeeAmount,
  );
  return {
    ...voucher,
    appFeeRate,
    gasFeeAmount,
    totalPrice,
  };
}
```

### 3. Public Voucher Routes — `routes/vouchers.ts`

#### GET /api/vouchers (list)

```ts
// Sebelum return, inject fee fields:
const { appFeeRate, gasFeeAmount } = await getLiveFeeConfig();
const enriched = vouchersList.map((v) => injectFeeFields(v, appFeeRate, gasFeeAmount));

return c.json({
  vouchers: enriched,
  pagination: { ... },
});
```

#### GET /api/vouchers/:id (detail)

```ts
const { appFeeRate, gasFeeAmount } = await getLiveFeeConfig();
return c.json({ voucher: injectFeeFields(voucher, appFeeRate, gasFeeAmount) });
```

### 4. Admin Voucher Routes — `routes/admin/vouchers.ts`

#### POST /api/admin/vouchers (create)

Hapus:
- Fetch `systemConfig` dan `activeFee` untuk snapshot (lines 103-121)
- `appFeeRate`, `gasFeeAmount`, `totalPrice` dari `data` di `tx.voucher.create()` (lines 166-168)
- Import `calcTotalPrice` (line 9) — tidak lagi dipakai di file ini

Tetap simpan hanya `basePrice`.

#### GET /api/admin/vouchers (list)

Inject computed fee fields ke response, sama seperti public route.

#### GET /api/admin/vouchers/:id (detail)

Inject computed fee fields ke response.

### 5. Backend Schema — `schemas/voucher.ts`

Update komentar di `updateVoucherSchema`:

```ts
// Note: basePrice, qrPerSlot are read-only after creation
// appFeeRate, gasFeeAmount, totalPrice are computed from live settings
```

### 6. App Frontend Schema — `app/src/lib/schemas/voucher.ts`

Tidak perlu berubah — backend masih mengirim `appFeeRate`, `gasFeeAmount`, `totalPrice` di response (sekarang computed, bukan snapshot). Schema Zod tetap required.

### 7. Back-office Types — `back-office/src/types/index.ts`

Tidak perlu berubah — `appFeeRate?`, `gasFeeAmount?`, `totalPrice?` sudah optional.

## Technical Notes

- **`calcTotalPrice()` di `pricing.ts`**: Tetap ada, sekarang dipakai oleh route handlers (bukan voucher creation)
- **`calculatePricing()` di `pricing.ts`**: Tidak terpengaruh — dipakai oleh `initiateRedemption()` yang sudah pakai live rate
- **Performance**: `getLiveFeeConfig()` menambah 1-2 query per request. Ini acceptable karena AppSettings dan FeeSetting adalah tabel kecil (1 row each). Bisa di-cache nanti jika perlu.
- **Fallback**: Jika tidak ada `FeeSetting` aktif, `gasFeeAmount` default ke `0`. Jika tidak ada `AppSettings`, `appFeeRate` default ke `3.00`.
- **Data lama**: Kolom dihapus dari DB, data snapshot hilang. Ini intentional — tidak ada kebutuhan audit trail untuk snapshot fee.
- **Redemption.gasFeeAmount**: Field terpisah di model `Redemption`, TIDAK dihapus. Ini menyimpan gas fee dalam WEALTH (bukan IDR) per transaksi redemption.

## Impact Analysis

| Area | Berubah? | Detail |
|------|----------|--------|
| `initiateRedemption()` | TIDAK | Sudah pakai live rate |
| `confirmRedemption()` | TIDAK | Tidak pakai fee |
| `failRedemption()` | TIDAK | Tidak pakai fee |
| Public voucher list | YA | Inject computed fee fields |
| Public voucher detail | YA | Inject computed fee fields |
| Admin voucher list | YA | Inject computed fee fields |
| Admin voucher detail | YA | Inject computed fee fields |
| Admin voucher create | YA | Hapus snapshot, hanya simpan basePrice |
| App frontend schema | TIDAK | Backend tetap kirim field yang sama |
| App voucher-card.tsx | TIDAK | Tetap baca `totalPrice` dari response |
| App voucher detail | TIDAK | Tetap baca `totalPrice`, `gasFeeAmount`, compute `appFeeIdr` |
| Back-office types | TIDAK | Field sudah optional |
| DB schema | YA | Drop 3 kolom dari vouchers |

## Sources

- **Origin brainstorm:** [docs/brainstorms/2026-05-01-live-fee-rate-brainstorm.md](../brainstorms/2026-05-01-live-fee-rate-brainstorm.md) — key decisions: hapus kolom DB, compute di API, format response tetap sama
- Backend pricing: `src/services/pricing.ts` — `calcTotalPrice()` reused for on-the-fly computation
- Redemption service: `src/services/redemption.ts:30-39` — already uses live rate (no changes needed)
- Public routes: `src/routes/vouchers.ts` — inject fee fields into response
- Admin routes: `src/routes/admin/vouchers.ts:103-168` — remove snapshot logic from create
