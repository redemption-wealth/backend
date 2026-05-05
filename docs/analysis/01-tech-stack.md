# 01 — Tech Stack

## Framework & Runtime

| Item | Value | Evidence |
|------|-------|----------|
| Framework | Hono 4.7.11 | `package.json:47` |
| Runtime | Node.js ≥20 (ESM) | `package.json:5-7`, `src/index.ts:2` |
| Deployment target | Vercel serverless | `vercel.json`, `api/index.ts` |
| Entry point (local) | `src/index.ts` → `@hono/node-server` | `src/index.ts:2,9` |
| Entry point (Vercel) | `api/index.ts` → re-exports app | `api/index.ts:1-4` |
| Build | `tsc` (compiles to `dist/`) | `package.json:10` |
| Module format | `"type": "module"` (ESM imports) | `package.json:4` |

## Database

| Item | Value | Evidence |
|------|-------|----------|
| Database | PostgreSQL (Supabase hosted) | `.env.example:2` |
| ORM | Prisma 7.7 | `package.json:34,51` |
| Driver adapter | `@prisma/adapter-pg` (direct pg Pool) | `package.json:33`, `src/db.ts:2-3` |
| Pool config | max=3, idleTimeout=60s, connTimeout=10s | `src/db.ts:16-20` |
| Connection recovery | Proxy auto-rebuilds on pool error | `src/db.ts:42-48` |
| RLS | Not used (direct driver, bypasses Supabase RLS) | Architecture |

## Auth Libraries

| Item | Value | Evidence |
|------|-------|----------|
| Admin auth | JWT via `jose` 6.2.2 | `package.json:45`, `src/middleware/auth.ts:4` |
| Admin token expiry | 24h, HS256 | `src/middleware/auth.ts:60-63` |
| User auth | Privy `@privy-io/server-auth` 1.32.5 | `package.json:38`, `src/middleware/auth.ts:3` |
| Password hashing | `bcryptjs` cost=12 | `src/routes/auth.ts:118` |

## Validation

| Item | Value | Evidence |
|------|-------|----------|
| Schema library | Zod 4.3.6 | `package.json:50` |
| Route validator | `@hono/zod-validator` 0.7.6 | `package.json:32` |
| Usage pattern | Manual `safeParse()` in most routes (not via middleware validator) | All route files |

Note: `@hono/zod-validator` is installed but the routes use manual `.safeParse()` — the middleware helper is not actually used.

## External Storage

| Item | Value | Evidence |
|------|-------|----------|
| Storage | Cloudflare R2 | `src/services/r2.ts` |
| SDK | `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` | `package.json:27-28` |
| Two buckets | QR (private, signed URLs) + Logos (public) | `src/services/r2.ts:123`, `src/routes/admin/upload.ts:51` |

## Blockchain

| Item | Value | Evidence |
|------|-------|----------|
| EVM client | `viem` 2.47.12 | `package.json:49`, `src/services/redemption.ts:4` |
| RPC provider | Alchemy (`ALCHEMY_RPC_URL`) | `src/services/redemption.ts:202` |
| Supported chains | mainnet (1) or sepolia (11155111) | `src/services/redemption.ts:205-206` |
| QR code generation | `qrcode` 1.5.4 (PNG buffer) | `package.json:48`, `src/services/qr-generator.ts:17` |

## Caching

| Item | Value | Evidence |
|------|-------|----------|
| Price cache | Module-level variable, TTL 60s | `src/services/price.ts:1-4` |
| FX rate cache | Module-level variable, TTL 15min | `src/services/price.ts:2,5` |
| Analytics cache | `node-cache` TTL 300s | `src/services/analytics.ts:4-7` |
| Rate limit store | In-memory `Map` | `src/middleware/rate-limit.ts:15` |

**⚠️ Serverless caveat**: All caches are in-memory and per-instance. On Vercel, instances are ephemeral and not shared — effective cache hit rate is near zero under real load.

## Testing

| Item | Value | Evidence |
|------|-------|----------|
| Test runner | Vitest 4.1.4 | `package.json:64` |
| Integration DB | testcontainers/postgresql | `package.json:53` |
| Mock helper | vitest-mock-extended | `package.json:65` |
| Test projects | unit, integration, e2e | `vitest.config.ts` |

## Required Environment Variables

```
# Database
DATABASE_URL

# Server
PORT                         (default: 3001)
CORS_ORIGINS

# Privy
PRIVY_APP_ID
PRIVY_APP_SECRET

# Admin JWT
ADMIN_JWT_SECRET             (REQUIRED — app crashes without it)

# Blockchain
WEALTH_CONTRACT_ADDRESS
ALCHEMY_RPC_URL              (default Sepolia in .env.example — see FLAG below)
ETHEREUM_CHAIN_ID            (default: 1 in code, 11155111 in .env.example)
ALCHEMY_WEBHOOK_SIGNING_KEY  (defined but not yet used — signature check TODO'd out)

# Price feed
CMC_API_KEY
WEALTH_CMC_SLUG              (default: "wealth-crypto")

# R2 Storage
CLOUDFLARE_ACCOUNT_ID        (⚠️ .env.example has R2_ACCOUNT_ID — name mismatch)
R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY
R2_QR_BUCKET_NAME            (default: "wealth-qr-codes")
R2_LOGO_BUCKET_NAME          (default: "wealth-merchant-logos")
R2_LOGO_PUBLIC_URL           (required for logo public URLs)

# One-time setup
SETUP_KEY
DEV_WALLET_ADDRESS

# Seed only
INITIAL_OWNER_EMAIL
INITIAL_OWNER_PASSWORD
```

### 🚩 ENV VAR MISMATCHES (.env.example vs code)

| .env.example | Code expects | File | Impact |
|---|---|---|---|
| `R2_ACCOUNT_ID` | `CLOUDFLARE_ACCOUNT_ID` | `src/services/r2.ts:13` | R2 client gets empty string — all uploads fail |
| `R2_BUCKET_NAME` | Not used | — | Misleading |
| `R2_PUBLIC_URL` | `R2_LOGO_PUBLIC_URL` | `src/services/r2.ts:124` | Logo URL throws error |
| `ALCHEMY_API_KEY` | Not used directly | — | Only `ALCHEMY_RPC_URL` is read |
| `TREASURY_WALLET_ADDRESS` | Not read from env | — | Stored in AppSettings via `DEV_WALLET_ADDRESS` |
