---
date: 2026-04-12
topic: backend-overhaul
---

# Backend Overhaul — Accommodate Full Platform Requirements

## What We're Building

Update the dedicated Hono backend to fully support the WEALTH redemption platform as described in the back-office PROJECT_BRIEF. Key changes:

1. **Multi-QR per Redemption** — 1 voucher can return 1 or 2 QR codes
2. **3-Component Pricing** — Base Price + App Fee (3%) + Gas Fee (fixed IDR)
3. **First-Login Password Flow** — nullable passwordHash, set-password endpoint
4. **Real-time Price via CoinGecko** — replace mock with live $WEALTH/IDR
5. **FeeSetting Model** — new table for admin-managed gas fees
6. **Comprehensive Security** — Zod validation, rate limiting, balance checks
7. **Full Test Suite** — unit, integration, e2e with positive/negative/edge cases

## Key Decisions

- **Gas Fee**: Fixed IDR amount set manually by admin (no blockchain gas oracle)
- **Price API**: CoinGecko free tier for $WEALTH → IDR conversion
- **Scope**: Backend only (schema + routes + services + tests). Frontend later.
- **Test Framework**: Vitest (consistent with existing ecosystem)

## Schema Changes Required

| Model | Change | Detail |
|-------|--------|--------|
| Admin | passwordHash nullable | `String?` for first-login flow |
| Voucher | Add qrPerRedemption | `Int @default(1)` — 1 or 2 |
| QrCode | Add redemptionId | `String?` FK to Redemption (replaces 1:1) |
| Redemption | Remove qrCodeId | Now one-to-many via QrCode.redemptionId |
| AppSettings | Rename field | devCutPercentage → appFeePercentage |
| FeeSetting | NEW model | label, amountIdr, isActive (1 active at a time) |

## Next Steps

→ Implement all changes, write tests, verify everything works.
