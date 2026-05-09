# 00 — Backend Analysis Overview

**Project**: WEALTH Token Redemption Platform — Backend API  
**Analysis date**: 2026-05-04  
**Codebase state**: `main` branch, HEAD `9646904`  
**Stack**: Hono 4.7 / Node.js ≥20 / Prisma 7.7 / PostgreSQL / Vercel serverless  
**Total endpoints**: 60 (6 public auth, 9 public user-facing, 45 admin)

---

## Architecture in One Paragraph

Hono REST API deployed as a Vercel serverless function (single entry `api/index.ts`). Two route tiers: public (`/api/*`) and admin-protected (`/api/admin/*` via sub-router with global `requireAdmin` middleware). Admin auth uses custom JWT (jose, 24h); user auth delegates to Privy. Database accessed via Prisma ORM (direct pg Pool, not Supabase JS client — no RLS). WEALTH price from CoinMarketCap + USD/IDR from open.er-api.com. QR images (PNG) generated at redemption time and stored in Cloudflare R2. On-chain confirmation via Alchemy webhook + on-demand viem reconciliation.

---

## 🚩 FLAGS — High Priority Findings

### FLAG 1: Chain ID Default is Sepolia (`.env.example`)
`.env.example` defaults `ALCHEMY_RPC_URL` to `eth-sepolia.g.alchemy.com` and `ETHEREUM_CHAIN_ID=11155111`. The contract address comment shows mainnet `0xafa702c0...` but the default is Sepolia `0x3e8c88aA...`. Production deployment MUST explicitly override both to mainnet values. See: `.env.example:17-23`, `src/services/redemption.ts:204-206`.

### FLAG 2: Webhook Signature Verification TODO'd Out
`POST /api/webhook/alchemy` checks header presence only — HMAC verification is commented out. Any party can confirm or fail redemptions by crafting a webhook payload. See: `src/routes/webhook.ts:17-20`. **Critical security gap.**

### FLAG 3: Client-Supplied Price Not Validated
`wealthPriceIdr` in `POST /api/vouchers/:id/redeem` comes from FE and is used directly for WEALTH amount calculation without server-side validation. User can submit inflated price → pay far less WEALTH. See: `src/services/redemption.ts:79-82`.

### FLAG 4: `coingeckoApiKey` — Dead Field with Misleading Semantics
`AppSettings.coingeckoApiKey` is stored in DB and exposed in settings API, but `services/price.ts` only reads `process.env.CMC_API_KEY`. The field does nothing. This is NOT CoinGecko — price source is confirmed CoinMarketCap. See: `prisma/schema.prisma:243`, `src/routes/admin/settings.ts:37`. **Historical artifact from before CMC integration — must be removed to avoid confusion.**

### FLAG 5: R2 Env Var Name Mismatch
Code reads `CLOUDFLARE_ACCOUNT_ID` (`src/services/r2.ts:13`) but `.env.example` defines `R2_ACCOUNT_ID`. Also: `R2_BUCKET_NAME` and `R2_PUBLIC_URL` in `.env.example` don't match what code reads (`R2_QR_BUCKET_NAME`, `R2_LOGO_BUCKET_NAME`, `R2_LOGO_PUBLIC_URL`). All R2 operations will fail silently if following `.env.example` as-is.

### FLAG 6: Missing Migration for `categories` Table
The `categories` table and `merchants.category_id` FK exist in `schema.prisma` but no migration creates them. The migration history starts with a `MerchantCategory` enum (old design) and never migrates to the Category FK pattern. The table was likely created via `prisma db push`. Running `prisma migrate deploy` on a fresh DB will produce an inconsistent state.

### FLAG 7: Double-Decrement of `remainingStock`
`voucher.remainingStock` is decremented twice per successful redemption: once by `confirmRedemption()` (on-chain webhook, `redemption.ts:177`) and once by QR scan completion (`qr-codes.ts:84`). Stock counter becomes inaccurate — a 10-slot voucher with 5 redemptions shows `remainingStock = 0` after just 5 completions instead of 5. Affects stock availability checks.

---

## Confirmed Service Integrations

| Service | Status | Notes |
|---------|--------|-------|
| CoinMarketCap | ✅ Confirmed | `CMC_API_KEY` env var, v2 quotes endpoint |
| open.er-api.com | ✅ Confirmed | Free FX rate, no API key, cached 15min |
| Alchemy RPC (Ethereum) | ✅ Confirmed | Via viem, mainnet/sepolia based on `ETHEREUM_CHAIN_ID` |
| Alchemy Webhook | ⚠️ Partial | Signature check unimplemented |
| Privy | ✅ Confirmed | Server-side auth verification |
| Cloudflare R2 | ✅ Confirmed | QR (private) + logo (public) buckets |
| Etherscan | ❌ Not present | No Etherscan integration found |
| BaseScan | ❌ Not present | No Base network references found |
| CoinGecko | ❌ Dead field only | `coingeckoApiKey` stored in DB but never read by price service |

---

## Known Dead Code

- `src/services/fee-setting.ts` — exported functions not imported anywhere (logic duplicated inline in routes)
- `POST /api/admin/qr-codes` — deprecated manual QR creation (schema says "DEPRECATED")
- `GET /api/admin/analytics/treasury-balance` — permanent stub returning `balance: "0"`
- `coingeckoApiKey` in AppSettings — stored but never read

---

## Key Coupling Points for FE Refactor

1. **Pagination**: Always `page`/`limit` query params, `pagination` object in response
2. **Auth header**: `Authorization: Bearer <token>` for both admin JWT and Privy token
3. **Decimal amounts**: Serialized as strings (e.g., `"123.456000000000000000"`) — FE must not `parseFloat()`
4. **QR images**: Only `GET /api/redemptions/:id` returns signed URLs — list endpoint returns raw R2 keys
5. **Admin login**: Two-step (check-email → set-password/login)
6. **Categories response**: Uses `{ data: [...] }` wrapper — inconsistent with other endpoints
7. **QR scan error codes**: `error` field IS the code string (e.g., `"NOT_FOUND"`, `"ALREADY_USED"`) — inconsistent with other endpoints where `error` is human-readable

---

## Document Index

| File | Contents |
|------|----------|
| `01-tech-stack.md` | Runtime, ORM, auth libraries, env vars, mismatches |
| `02-architecture.md` | Folder tree, route pattern, middleware, separation of concerns |
| `03-endpoints.md` | All 60 endpoints with auth, request/response shapes, file refs |
| `04-auth-permissions.md` | Auth flows, role matrix, middleware chain, inconsistencies |
| `05-data-layer.md` | All 11 tables, migration history, source of truth, known issues |
| `06-external-services.md` | CMC, FX, Alchemy, Privy, R2 — setup, env vars, gaps |
| `07-business-flows.md` | End-to-end traces for redemption, QR scan, voucher creation, price fetch |
| `08-pain-points.md` | 20 issues (P1–P20), severity-rated with evidence |
| `09-cross-repo-coupling.md` | Pagination, error shapes, dates, numeric types, implicit FE contracts |
