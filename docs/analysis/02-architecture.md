# 02 — Folder Structure & Architecture

## Folder Tree

```
backend/
├── api/
│   └── index.ts              Vercel serverless entry (re-exports app)
├── prisma/
│   ├── schema.prisma          Canonical DB schema
│   ├── seed.ts                Dev seed (owner + test accounts)
│   └── migrations/            6 migration files (Apr 9–Apr 24 2026)
├── src/
│   ├── app.ts                 Hono app setup, route mounting, error handler
│   ├── index.ts               Node.js entry point (dev/prod)
│   ├── db.ts                  Prisma client with pool recovery proxy
│   ├── middleware/
│   │   ├── auth.ts            requireAdmin, requireUser, requireOwner, requireManager
│   │   └── rate-limit.ts      loginLimiter, setPasswordLimiter, qrScanLimiter
│   ├── routes/
│   │   ├── auth.ts            /api/auth — admin auth + user sync
│   │   ├── merchants.ts       /api/merchants — public
│   │   ├── vouchers.ts        /api/vouchers — public + user redeem
│   │   ├── redemptions.ts     /api/redemptions — user-scoped
│   │   ├── transactions.ts    /api/transactions — user-scoped
│   │   ├── price.ts           /api/price — public
│   │   ├── webhook.ts         /api/webhook/alchemy — no auth
│   │   ├── categories.ts      /api/categories — public
│   │   ├── setup.ts           /api/setup/init-owner — one-time
│   │   └── admin/
│   │       ├── merchants.ts   /api/admin/merchants
│   │       ├── vouchers.ts    /api/admin/vouchers
│   │       ├── qr-codes.ts    /api/admin/qr-codes
│   │       ├── redemptions.ts /api/admin/redemptions
│   │       ├── admins.ts      /api/admin/admins (owner only)
│   │       ├── analytics.ts   /api/admin/analytics
│   │       ├── fee-settings.ts /api/admin/fee-settings
│   │       ├── settings.ts    /api/admin/settings (owner only)
│   │       └── upload.ts      /api/admin/upload/logo
│   ├── schemas/
│   │   ├── common.ts          paginationSchema, uuidParamSchema
│   │   ├── auth.ts            loginSchema, setPasswordSchema, changePasswordSchema
│   │   ├── admin.ts           createAdminSchema, updateAdminSchema, adminQuerySchema
│   │   ├── merchant.ts        createMerchantSchema, updateMerchantSchema, merchantQuerySchema
│   │   ├── voucher.ts         createVoucherSchema, updateVoucherSchema, redeemVoucherSchema, voucherQuerySchema
│   │   ├── qr-code.ts         createQrCodeSchema (deprecated), scanQrSchema
│   │   ├── fee-setting.ts     createFeeSettingSchema, updateFeeSettingSchema
│   │   └── settings.ts        updateSettingsSchema
│   └── services/
│       ├── price.ts           CMC + FX rate fetching + in-memory cache
│       ├── pricing.ts         WEALTH amount calculation (calculatePricing, calcTotalPrice)
│       ├── redemption.ts      initiateRedemption, confirmRedemption, failRedemption, reconcile
│       ├── qr-generator.ts    generateQrCode (PNG → R2 upload)
│       ├── r2.ts              uploadFile, deleteFile, generateSignedUrl, getPublicUrl
│       ├── analytics.ts       7 analytics query functions + node-cache
│       └── fee-setting.ts     getActiveFee, activateFee, deactivateFee (helpers)
└── tests/                     Vitest tests (unit / integration / e2e)
```

## Route Organization Pattern

**Per-resource files** — one file per resource, not per-feature. Each file exports a `Hono` instance that gets mounted via `app.route()`.

**Two tiers:**
1. **Public routes** — mounted at `/api/*` directly on the top-level app
2. **Admin routes** — mounted on a sub-router (`const admin = new Hono<AuthEnv>()`) that has `requireAdmin` applied globally via `admin.use("*", requireAdmin)`, then mounted at `/api/admin`

```
app.ts:64-75
const admin = new Hono<AuthEnv>();
admin.use("*", requireAdmin);          ← single middleware covers all admin routes
admin.route("/merchants", ...);
admin.route("/vouchers", ...);
...
app.route("/api/admin", admin);
```

## Middleware Layer

| Middleware | Where applied | Effect |
|---|---|---|
| `logger()` | Global (`*`) | Request/response logging |
| `cors()` | Global (`*`) | Origin allowlist from `CORS_ORIGINS` env |
| `requireAdmin` | All `/api/admin/*` + analytics sub-use | Verifies JWT + DB lookup per request |
| `requireUser` | Per-route (redemptions, transactions, user sync) | Verifies Privy token + DB lookup |
| `requireOwner` | Per-route (merchants/select, admins/*, settings) | Role check after requireAdmin |
| `requireManager` | Per-route (create merchant, fee ops, upload) | Role check after requireAdmin |
| `qrScanLimiter` | POST /api/admin/qr-codes/scan | 60 req/min per adminId |
| `loginLimiter` | ⚠️ DEFINED but NEVER APPLIED | Intended for POST /api/auth/login |
| `setPasswordLimiter` | ⚠️ DEFINED but NEVER APPLIED | Intended for POST /api/auth/set-password |

## Separation of Concerns

| Layer | Location | Responsibility |
|---|---|---|
| Route handler | `src/routes/**/*.ts` | Parse request, validate, call service/DB, format response |
| Business logic | `src/services/*.ts` | Multi-step flows (redemption, QR gen, pricing), external API calls |
| Data access | Prisma client calls (inline in routes AND services) | No dedicated repository layer |
| Schema/validation | `src/schemas/*.ts` | Zod input shapes |
| Middleware | `src/middleware/*.ts` | Auth, rate limiting |

**Note**: There is no dedicated repository/data-access layer. DB queries are written inline in route handlers and sometimes in services. This creates some duplication (e.g., redemption queries appear in both `routes/redemptions.ts` and `services/redemption.ts`).

## Error Handling Strategy

```
app.ts:78-84
app.onError((err, c) => {
  if ("status" in err && typeof err.status === "number") {
    return c.json({ error: err.message }, err.status);  // HTTPException passthrough
  }
  return c.json({ error: "Internal Server Error" }, 500);  // Generic fallback
});
```

- `HTTPException` (from `requireAdmin`/`requireUser`) → status + message from exception
- All other errors → 500 "Internal Server Error" (message swallowed)
- Route-level errors → handled per-route with specific JSON shapes

## Admin Analytics Double-Middleware

`analytics.ts:15` applies `requireAdmin` again as a sub-use middleware even though the parent admin sub-router already applies it. This results in two DB lookups per analytics request (harmless but wasteful).

```javascript
adminAnalytics.use("/*", requireAdmin);  // redundant
```
