# 09 — Cross-Repo Coupling

Things the backend dictates that FE must match — explicitly or implicitly.

---

## Pagination Convention

**All paginated endpoints** use the same convention:

- **Request**: `?page=1&limit=20` (defaults: page=1, limit=20, max=100)
- **Response**: `{ [resource]: [...], pagination: { page, limit, total, totalPages } }`
- **Sorting**: Always `orderBy: { createdAt: "desc" }` — newest first, not configurable

**FE assumption risk**: FE cannot request ascending order or sort by any other field. If the back-office has a "sort by name" feature, it must sort client-side.

---

## Response Wrapper Key Inconsistency

Different endpoints use different top-level keys. FE must handle each:

| Endpoint | Wrapper |
|----------|---------|
| `GET /api/categories` | `{ data: [...] }` |
| `GET /api/categories/:id` | `{ data: {...} }` |
| `GET /api/admin/analytics/*` | `{ data: [...] }` or `{ summary: {...} }` or `{ activities: [...] }` |
| All merchant endpoints | `{ merchant }` / `{ merchants, pagination }` |
| All voucher endpoints | `{ voucher }` / `{ vouchers, pagination }` |
| All admin endpoints | `{ admin }` / `{ admins, pagination }` |
| Redemption list | `{ redemptions, pagination }` |
| Redemption detail | `{ redemption }` |
| Price | `{ priceIdr, cached, stale? }` (no wrapper) |
| Fee settings | `{ feeSetting }` / `{ feeSettings }` |
| Settings | `{ settings }` |
| Health | `{ status, timestamp }` |
| Categories uses `data`, others don't — **no unified convention**.

---

## Error Response Shape

**Standard**: `{ error: string }` — HTTP status in code, message in `error` field.

**Validation errors**: `{ error: "Validation failed", details: ZodFlattenedError }` — FE must parse `details.fieldErrors` for per-field messages.

**Domain errors with codes**: `{ error: string, code: string }` — used in:
- `POST /api/admin/vouchers` → `{ error: "...", code: "NO_ACTIVE_FEE" }` (422)
- `PUT /api/admin/vouchers/:id` → `{ error: "...", code: "BELOW_FLOOR", floor, requested }` (422)
- `DELETE /api/admin/vouchers/:id` → `{ code: "VOUCHER_HAS_ACTIVE_QR" }` (422)
- `POST /api/admin/qr-codes/scan` → error is the code itself: `"NOT_FOUND"`, `"WRONG_MERCHANT"`, `"QR_NOT_REDEEMED"`, `"ALREADY_USED"` — **the `error` field IS the code string** (inconsistent with other endpoints)
- `POST /api/admin/admins/:id/reset-password` → `{ code: "CANNOT_RESET_SELF" }`, `{ code: "CANNOT_RESET_LAST_OWNER" }`

**FE must handle**: QR scan errors where `error === "NOT_FOUND"` (not human-readable) vs. most other endpoints where `error` is a user-readable message.

---

## Date Format Convention

All timestamps serialized as ISO 8601 strings: `"2026-04-14T17:31:47.147Z"`

`startDate` and `expiryDate` on Voucher are `@db.Date` (date-only) — serialized as `"2026-04-14T00:00:00.000Z"` (midnight UTC). FE must not assume time component is meaningful.

When creating/updating vouchers, FE sends dates as ISO strings or Date objects (`z.string().or(z.date())`).

---

## Numeric Types & Serialization

Prisma `Decimal` fields are serialized by Prisma/JSON as **strings** (to preserve precision):
- `wealthAmount` (`Decimal(36,18)`) → `"0.001234567890000000"`
- `basePrice` (`Decimal(15,2)`) → `"150000.00"`
- `appFeeRate` (`Decimal(5,2)`) → `"3.00"`

`priceIdrAtRedeem` is an `Int` → serialized as JavaScript number.
`totalUsers`, `totalRedemptions`, etc. in analytics → numbers.

**FE must**: Use BigDecimal/string operations for WEALTH amounts. Do not use `parseFloat()` for Decimal fields — precision loss is guaranteed.

---

## Auth Header Convention

Both admin JWT and Privy token use `Authorization: Bearer <token>`. Endpoints are consistent.

---

## QR Image URL Contract

The `qrCodes[].imageUrl` field can be:
1. **Placeholder**: `https://placeholder.qr/{uuid}` — at voucher creation time (never resolvable)
2. **R2 key**: `qr-codes/{redemptionId}/{n}.png` — after user redeems, before signing
3. **Signed URL**: Full `https://...r2.cloudflarestorage.com/...?X-Amz-Signature=...` — after backend signs it, valid 1h

FE currently receives:
- `GET /api/redemptions` (list) → type 2 (R2 key, NOT signed)
- `GET /api/redemptions/:id` (detail) → type 3 (signed URL, valid 1h)
- `GET /api/admin/redemptions` → type 2 (R2 key, never signed)

**FE should**: Only display QR images from `GET /api/redemptions/:id`. The list endpoint's `qrCodes` are not displayable without signing. This is not documented anywhere.

---

## FE-Supplied `wealthPriceIdr`

The `POST /api/vouchers/:id/redeem` body requires `wealthPriceIdr: number`. The FE is expected to:
1. Call `GET /api/price/wealth` to get current `priceIdr`
2. Pass that value as `wealthPriceIdr` in the redeem body

Backend uses this price for WEALTH amount calculation without server-side validation. If FE uses a stale or incorrect price, the WEALTH amount will be wrong. There is no server-side guardrail.

**FE must**: Fetch fresh price immediately before redemption. Backend returns `{ stale: true }` if using cached stale data — FE should warn user in this case.

---

## Admin Login — Two-Step Protocol

The FE back-office must implement a specific two-step login flow:
1. `POST /api/auth/check-email` → if `needs_password_setup: true`, redirect to set-password UI
2. Either `POST /api/auth/set-password` (first time) or `POST /api/auth/login` (returning)

This means the back-office cannot use a simple single-step login form — it must query email first.

**There is no token refresh endpoint.** After 24h, the JWT expires and the admin must re-login.

---

## Category Filter API Contract

`GET /api/vouchers` accepts `?category=string` for category name filtering. Due to the broken filter (`src/routes/vouchers.ts:33`), this parameter may not work correctly. FE may be assuming `?category=kuliner` filters by category name — but the backend filter is likely a no-op or error in the current schema.

`GET /api/admin/merchants` accepts `?categoryId=uuid` (correct UUID-based filter).

**Inconsistency**: Public voucher endpoint uses string name, admin merchant endpoint uses UUID. FE must handle both conventions.

---

## Missing Aggregate Endpoints (Back-Office Issue)

The analytics endpoints require multiple calls for a comprehensive dashboard view:

| Dashboard panel | Calls needed |
|----------------|-------------|
| Summary KPIs | `GET /api/admin/analytics/summary` |
| Activity feed | `GET /api/admin/analytics/recent-activity` |
| Chart: redemptions over time | `GET /api/admin/analytics/redemptions-over-time?period=...` |
| Chart: WEALTH volume | `GET /api/admin/analytics/wealth-volume?period=...` |
| Chart: category split | `GET /api/admin/analytics/merchant-categories` |
| Top merchants | `GET /api/admin/analytics/top-merchants` |
| Top vouchers | `GET /api/admin/analytics/top-vouchers` |

A full dashboard requires **7 parallel API calls** (or more if different periods needed). No aggregate "dashboard" endpoint exists. FE must fan out in parallel.

---

## Soft Delete Visibility

Backend soft-deletes merchants, vouchers, and admins (`deletedAt` field). Public endpoints filter by `isActive: true` + `remainingStock > 0` but NOT `deletedAt: null`. Admin list endpoints filter by `deletedAt: null`. 

**FE assumption to verify**: If FE shows `isActive` as "hidden" rather than "deleted," a soft-deleted merchant that's also `isActive: false` appears the same from the FE perspective. The `deletedAt` field is returned in admin responses, but the FE must check it explicitly if it wants to distinguish "deactivated" vs "deleted."

---

## File Upload Contract

`POST /api/admin/upload/logo`:
- Content-Type: `multipart/form-data`
- Field name: `file` OR `logo` (both accepted)
- Max size: 5MB
- Allowed types: any `image/*` MIME type (detected via file magic bytes, not extension)
- Response: `{ url, filename, size, contentType }` where `url` is the public R2 URL
- The returned `url` must be saved manually by FE into the merchant's `logoUrl` field via `PUT /api/admin/merchants/:id`

**Upload is decoupled from merchant update** — FE must make two calls to change a logo.
