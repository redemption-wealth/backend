---
date: 2026-05-01
topic: live-fee-rate
---

# Live Fee Rate — Hapus Snapshot, Selalu Pakai Rate Terkini

## What We're Building

Mengubah sistem fee voucher dari snapshot (disimpan per voucher saat dibuat) menjadi live (selalu dihitung dari settings terkini). Ini mencakup:

1. Hapus kolom `app_fee_rate`, `gas_fee_amount`, `total_price` dari tabel `vouchers`
2. Backend API menghitung fee on-the-fly dari `AppSettings.appFeeRate` + `FeeSetting` aktif
3. Response API tetap menyertakan `appFeeRate`, `gasFeeAmount`, `totalPrice` (computed)
4. Frontend schema dan type disesuaikan

## Why This Approach

- Snapshot menyebabkan harga voucher tidak berubah saat admin update fee rate
- Redemption sudah pakai live rate — ada inkonsistensi antara harga yang ditampilkan dan yang dicharge
- User bingung karena harga tetap lama padahal sudah update settings
- Full migration sekarang agar tidak ada utang teknis

## Key Decisions

- **Hapus kolom DB**: Migrasi Prisma untuk drop `app_fee_rate`, `gas_fee_amount`, `total_price` dari vouchers
- **Compute di API**: Backend menghitung `totalPrice = basePrice + (basePrice * appFeeRate / 100) + gasFeeAmount` di setiap response
- **Format response tetap sama**: Frontend tidak perlu tahu bahwa field ini sekarang computed
- **Voucher creation tidak lagi simpan snapshot**: Hanya simpan `basePrice`
- **Redemption tidak berubah**: Sudah pakai live rate

## Impact Analysis

| Area | Berubah? | Detail |
|------|----------|--------|
| `initiateRedemption()` | TIDAK | Sudah pakai live rate |
| `confirmRedemption()` | TIDAK | Tidak pakai fee |
| `failRedemption()` | TIDAK | Tidak pakai fee |
| Public voucher API | YA | Hitung fee on-the-fly di response |
| Admin voucher API | YA | Hapus snapshot saat create, hitung di response |
| App frontend | YA | Update Zod schema (field jadi optional atau tetap) |
| Back-office frontend | MINIMAL | Type update |
| DB schema | YA | Drop 3 kolom dari vouchers |

## Open Questions

- None — ready for planning

## Next Steps

- `/ce:plan` for implementation details
