# 06 — External Service Integrations

## 1. CoinMarketCap (CMC)

| Item | Value |
|------|-------|
| Purpose | WEALTH token price in USD |
| Endpoint | `https://pro-api.coinmarketcap.com/v2/cryptocurrency/quotes/latest` |
| Auth | `X-CMC_PRO_API_KEY` header |
| Env vars | `CMC_API_KEY`, `WEALTH_CMC_SLUG` (default: "wealth-crypto") |
| Called from | `src/services/price.ts:36-51` |
| Cache TTL | 60 seconds (in-memory module variable) |
| Timeout | 5 seconds (`AbortSignal.timeout`) |
| Fallback | Stale cache if available; throws `"Failed to fetch price"` if no cache |
| Called by | `GET /api/price/wealth`, and indirectly by anything using price |

**Status**: ✅ Implemented and confirmed as primary price source. Uses CMC v2 API with slug-based lookup.

```typescript
// src/services/price.ts:8-9
const CMC_QUOTES_URL = "https://pro-api.coinmarketcap.com/v2/cryptocurrency/quotes/latest";
```

---

## 2. open.er-api.com (FX Rate)

| Item | Value |
|------|-------|
| Purpose | USD → IDR exchange rate for WEALTH/IDR conversion |
| Endpoint | `https://open.er-api.com/v6/latest/USD` |
| Auth | None (free tier) |
| Env vars | None |
| Called from | `src/services/price.ts:53-65` |
| Cache TTL | 15 minutes (in-memory module variable) |
| Timeout | 5 seconds |
| Fallback | Cached rate; throws on miss |

**Pricing formula**: `priceIdr = priceUsd * usdToIdr`

---

## 3. Alchemy (Ethereum RPC)

| Item | Value |
|------|-------|
| Purpose | Ethereum transaction receipt lookup (on-demand reconciliation) |
| SDK | `viem` (createPublicClient, getTransactionReceipt) |
| Env vars | `ALCHEMY_RPC_URL`, `ETHEREUM_CHAIN_ID` |
| Called from | `src/services/redemption.ts:198-208` |
| Chain selection | `chainId === 11155111 → sepolia; else → mainnet` |
| Client caching | Module-level singleton `cachedRpcClient` |

```typescript
// src/services/redemption.ts:204-206
const chainId = Number(process.env.ETHEREUM_CHAIN_ID ?? 1);
const chain = chainId === sepolia.id ? sepolia : mainnet;
cachedRpcClient = createPublicClient({ chain, transport: http(rpcUrl) });
```

### 🚩 HIGH PRIORITY — Chain Configuration

`.env.example` defaults:
```
ALCHEMY_RPC_URL="https://eth-sepolia.g.alchemy.com/v2/YOUR_KEY"
ETHEREUM_CHAIN_ID=11155111
```

This is **Sepolia testnet** (chain ID 11155111). The code defaults to mainnet (1) if `ETHEREUM_CHAIN_ID` is unset, but `.env.example` explicitly sets Sepolia. Production deployment must override both to mainnet values.

**Production values should be:**
```
ALCHEMY_RPC_URL="https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY"
ETHEREUM_CHAIN_ID=1
WEALTH_CONTRACT_ADDRESS="0xafa702c0A2a3a0Cf1bD09435DB61C913cCDe8546"
```

The mainnet address IS documented in `.env.example` comments but is NOT the default.

---

## 4. Alchemy Webhook

| Item | Value |
|------|-------|
| Purpose | Receive on-chain WEALTH transfer confirmations |
| Endpoint | `POST /api/webhook/alchemy` |
| Auth | `x-alchemy-signature` header (presence checked only) |
| Env vars | `ALCHEMY_WEBHOOK_SIGNING_KEY` (defined but unused) |
| Called from | `src/routes/webhook.ts` |

### 🚩 CRITICAL — Signature Verification TODO'd Out

```typescript
// src/routes/webhook.ts:17-20
// TODO: Verify signature with ALCHEMY_WEBHOOK_SIGNING_KEY
// const body = await c.req.text();
// const isValid = verifyAlchemySignature(signature, body, process.env.ALCHEMY_WEBHOOK_SIGNING_KEY);
```

The webhook **only checks that the `x-alchemy-signature` header exists** but does not verify its HMAC value. Any party can send a crafted payload to this endpoint and trigger `confirmRedemption()` or `failRedemption()`. This is a security vulnerability.

**Impact**: Attacker can confirm a redemption without actual on-chain payment, or fail a legitimate redemption.

---

## 5. Privy

| Item | Value |
|------|-------|
| Purpose | User authentication verification |
| SDK | `@privy-io/server-auth` PrivyClient |
| Env vars | `PRIVY_APP_ID`, `PRIVY_APP_SECRET` |
| Operations | `verifyAuthToken(token)`, `getUser(userId)` |
| Called from | `src/middleware/auth.ts:42-47`, `src/routes/auth.ts:184,188` |

**Used for**: Verifying user Privy tokens on every `requireUser` request + fetching user email/wallet during sync.

---

## 6. Cloudflare R2

| Item | Value |
|------|-------|
| Purpose | File storage (QR images + merchant logos) |
| SDK | `@aws-sdk/client-s3` (S3-compatible API) |
| Env vars | `CLOUDFLARE_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` |
| Called from | `src/services/r2.ts` |

### Two Buckets

| Bucket | Env var | Default | Access type | Usage |
|--------|---------|---------|-------------|-------|
| QR codes | `R2_QR_BUCKET_NAME` | `wealth-qr-codes` | Private (signed URLs) | QR PNGs for redemptions |
| Logos | `R2_LOGO_BUCKET_NAME` | `wealth-merchant-logos` | Public | Merchant logos |

**R2 key format for QR**: `qr-codes/{redemptionId}/{index}.png` (deterministic, idempotent on retry)
**Signed URL TTL**: 3600 seconds (1 hour) — `src/routes/redemptions.ts:10`
**Public URL prefix**: `R2_LOGO_PUBLIC_URL` env var (required for logo upload endpoint)

### 🚩 Env Var Name Mismatch

```typescript
// src/services/r2.ts:13
endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`
```

But `.env.example` defines `R2_ACCOUNT_ID`, not `CLOUDFLARE_ACCOUNT_ID`. If only `.env.example` is followed, the R2 client will use an empty string for the account ID and all uploads will fail silently.

Additional mismatches:
- `.env.example`: `R2_BUCKET_NAME` → not used in code (code uses `R2_QR_BUCKET_NAME`)
- `.env.example`: `R2_PUBLIC_URL` → code uses `R2_LOGO_PUBLIC_URL` (`src/services/r2.ts:124`)

---

## 7. No Etherscan / No BaseScan

There is **no** Etherscan or BaseScan integration. Block explorer data is retrieved entirely through the Alchemy RPC URL via `viem.getTransactionReceipt()`. There is no REST API call to any block explorer.

**No Base network** integration found anywhere in the codebase. The chain is always either mainnet (1) or sepolia (11155111).

---

## Service Dependency Map

```
POST /api/vouchers/:id/redeem
  └── services/redemption.ts:initiateRedemption
        ├── prisma (DB)
        └── services/qr-generator.ts:generateQrCode
              └── services/r2.ts:uploadFile   → Cloudflare R2

GET /api/price/wealth
  └── services/price.ts:getWealthPrice
        ├── CoinMarketCap API
        └── open.er-api.com (FX rate)

POST /api/webhook/alchemy
  └── services/redemption.ts:confirmRedemption / failRedemption
        └── prisma (DB) + services/r2.ts:deleteFiles (on fail)

GET /api/redemptions/:id (auto-reconcile)
  └── services/redemption.ts:reconcileRedemptionById
        └── viem → Alchemy RPC

POST /api/auth/user-sync
  └── privyClient.verifyAuthToken + privyClient.getUser → Privy

requireUser middleware
  └── privyClient.verifyAuthToken → Privy
```
