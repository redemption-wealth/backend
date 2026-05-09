---
title: "Backend Brief Alignment — Security, Endpoints, Business Logic"
type: feat
status: completed
date: 2026-05-04
origin: docs/brainstorms/2026-05-04-backend-brief-alignment-requirements.md
---

# Backend Brief Alignment — Security, Endpoints, Business Logic

## Overview

Implements all remaining backend work defined in `docs/brief/Wealth-Backend-Brief.md` and captured in the origin requirements document. Work is split into three phases so each phase can be verified independently before continuing.

**Phase 1 — Security & Access Control** (Groups A + D): Critical fixes required before mainnet. Low LOC, high risk if skipped.  
**Phase 2 — Missing Endpoints** (Group B): Seven new endpoints that the frontend expects but don't exist yet.  
**Phase 3 — Business Logic Corrections** (Group C): Two behavioral fixes that improve correctness and performance.

## Scope Boundaries

**In scope:**
- A1–A3, B1–B7, C1–C2, D1 from the origin requirements document
- Route-level access control middleware additions

**Out of scope (per origin doc):**
- Email-based password reset
- Rate limiter Redis backend
- Bulk actions
- Soft-delete restore
- Integration test rewrites (tests are stale against the old schema; out of scope for this work)

**Note on tests:** The three Vitest projects (`unit`, `integration`, `e2e`) exist at `tests/`. Integration tests reference models and fields dropped in the schema migration (`transaction`, `category`, `privyUserId`, lowercase status values, JWT-based auth helpers). Do not run integration tests as a verification step — use `pnpm tsc --noEmit` + TypeScript correctness as the primary gate.

---

## Phase 1 — Security & Access Control

**Items:** A3, A1, A2, D1  
**Verification gate:** `pnpm tsc --noEmit` passes; manual spot-checks for each item.

### Implementation Units

#### A3 — R2 Env Var Fix

**File:** `src/services/r2.ts`  
**Change:** Line 13 — `process.env.CLOUDFLARE_ACCOUNT_ID` → `process.env.R2_ACCOUNT_ID`

One character change. `.env.example` already has `R2_ACCOUNT_ID`. This makes them consistent.

---

#### A1 — Webhook HMAC Verification

**File:** `src/routes/webhook.ts`

**Mandatory operation order — do not rearrange:**

**Step 1 — Read raw body as string.** This MUST be the first operation in the handler, before anything else touches the request body:
```ts
const rawBody = await c.req.text()
// ↑ This consumes the readable stream. c.req.json() will throw after this.
// JSON.parse(rawBody) must be used later instead.
```

**Step 2 — Check signing key availability and enforce prod policy:**
```ts
const signingKey = process.env.ALCHEMY_WEBHOOK_SIGNING_KEY
const isProduction = process.env.NODE_ENV === "production"

if (!signingKey) {
  if (isProduction) return c.json({ error: "Webhook not configured" }, 401)
  console.warn("[webhook] ALCHEMY_WEBHOOK_SIGNING_KEY not set — skipping HMAC check in dev")
}
```

**Step 3 — If signing key present, verify HMAC using constant-time comparison:**
```ts
else {
  const signature = c.req.header("x-alchemy-signature")
  if (!signature) return c.json({ error: "Missing signature" }, 401)

  const computed = createHmac("sha256", signingKey).update(rawBody).digest("hex")
  const computedBuf = Buffer.from(computed, "hex")
  const sigBuf = Buffer.from(signature, "hex")

  if (computedBuf.length !== sigBuf.length || !timingSafeEqual(computedBuf, sigBuf)) {
    return c.json({ error: "Invalid signature" }, 401)
  }
}
```

**Step 4 — Parse body. Use `JSON.parse(rawBody)`, never `c.req.json()`:**
```ts
const body = JSON.parse(rawBody)
const { event } = body
// Continue with existing payload processing logic
```

**Why this order is non-negotiable:** `c.req.text()` and `c.req.json()` consume the same underlying Node.js readable stream. Once step 1 runs, the stream is exhausted — `c.req.json()` will throw if called afterward. The existing handler calls `c.req.json()` and must be replaced entirely with `JSON.parse(rawBody)` at step 4.

**Dev convenience:** If `ALCHEMY_WEBHOOK_SIGNING_KEY` is absent in non-production, log warning and continue processing (step 2 above). This allows local testing without Alchemy credentials.

---

#### A2 — Server-Side Price Validation

**Files:** `src/schemas/voucher.ts`, `src/routes/vouchers.ts`, `src/services/redemption.ts`

**Step 1 — Schema (`src/schemas/voucher.ts`):**  
Remove `wealthPriceIdr` from `redeemVoucherSchema`. Result:
```ts
export const redeemVoucherSchema = z.object({
  idempotencyKey: z.string().uuid(),
})
```

**Step 2 — Route (`src/routes/vouchers.ts`):**  
Remove `wealthPriceIdr` from body destructure and from `initiateRedemption` call:
```ts
const { idempotencyKey } = parsed.data
const { redemption, alreadyExists } = await initiateRedemption({
  userEmail: user.userEmail,
  voucherId,
  idempotencyKey,
  // wealthPriceIdr removed
})
```

**Step 3 — Service (`src/services/redemption.ts`):**

Remove `wealthPriceIdr` from `InitiateRedemptionParams` interface.

**Mandatory call order in `initiateRedemption`:**

```ts
import { getWealthPrice } from "./price.js"

export async function initiateRedemption({ userEmail, voucherId, idempotencyKey }) {
  // Step A: idempotency check (unchanged)
  const existing = await prisma.redemption.findFirst(...)
  if (existing) return { redemption: existing, alreadyExists: true }

  // Step B: fetch app settings for fees (unchanged)
  const settings = await prisma.appSettings.findUnique(...)

  // Step C: fetch WEALTH price — BEFORE opening the transaction
  let priceIdr: number
  try {
    const result = await getWealthPrice()
    priceIdr = result.priceIdr
  } catch {
    throw new Error("Price service unavailable")
  }
  // ↑ getWealthPrice() MUST be called here, outside prisma.$transaction().
  // Calling it inside the transaction holds the DB connection open during a
  // network round-trip to CMC, blocking concurrent redemptions on the same row.

  // Step D: open the Prisma transaction — uses priceIdr from the closure above
  const redemption = await prisma.$transaction(async (tx) => {
    // ... existing lock + slot logic ...
    const wealthPriceDecimal = new Prisma.Decimal(priceIdr)  // ← captured from step C
    // ... rest of pricing + create logic ...
  })
}
```

**Lines to remove from the current implementation:**
- `wealthPriceIdr` from `InitiateRedemptionParams` interface
- `const wealthPriceDecimal = new Prisma.Decimal(wealthPriceIdr)` (currently inside the `$transaction` callback — delete this line)
- `wealthPriceIdrAtRedeem: wealthPriceDecimal` from `redemption.create` — wait, this field MUST stay; only the source changes from the param to the closure variable

**Route handler error handling** (`src/routes/vouchers.ts`): The current `catch` block returns 400 for all errors. Detect price errors specifically:
```ts
} catch (error) {
  const message = error instanceof Error ? error.message : "Redemption failed"
  const status = message.includes("Price service unavailable") ? 503 : 400
  return c.json({ error: message }, status)
}
```

---

#### D1 — Activity Log Restricted to Owner

**File:** `src/routes/admin/redemptions.ts`

The admin sub-app already applies `requireAdmin` at `app.ts:62`. What's needed here is narrowing to Owner-only.

Add `requireOwner` middleware to the two existing handlers and the three new ones added in Phase 2 (B5, B6):

```ts
import { requireOwner } from "../../middleware/auth.js"

adminRedemptions.get("/", requireOwner, async (c) => { ... })
adminRedemptions.get("/:id", requireOwner, async (c) => { ... })
// B5 and B6 added in Phase 2 also use requireOwner
```

Note: route ordering matters in Hono — `/counts` and `/recent` must be registered BEFORE `/:id` to avoid the param catching them.

### Phase 1 Test Scenarios

| Scenario | Expected |
|----------|----------|
| GET `/api/admin/redemptions` as MANAGER | 403 Forbidden |
| GET `/api/admin/redemptions` as OWNER | 200 (list) |
| POST `/api/webhook/alchemy` with valid HMAC signature | 200 |
| POST `/api/webhook/alchemy` with wrong signature (prod env) | 401 |
| POST `/api/webhook/alchemy` with no signing key (dev env) | 200 (processes, logs warning) |
| POST `/api/webhook/alchemy` with no signing key (prod env) | 401 |
| POST `/api/vouchers/:id/redeem` with `wealthPriceIdr` in body | Ignored; server fetches price |
| POST `/api/vouchers/:id/redeem` when CMC unreachable + no stale cache | 503 |
| `pnpm tsc --noEmit` | Zero errors |

---

## Phase 2 — Missing Endpoints

**Items:** B1, B2, B3, B4, B5, B6, B7  
**Verification gate:** `pnpm tsc --noEmit` passes; each endpoint returns correct shape + correct 403 for wrong role.

### Route Registration

**`src/app.ts` — new import and mount:**
```ts
import adminOverviewRoutes from "./routes/admin/overview.js"

// Inside the admin sub-app — add before app.route("/api/admin", admin):
admin.route("/", adminOverviewRoutes)  // resolves /api/admin/overview and /api/admin/categories
```

B3, B4 are added to existing merchant/voucher admin route files.  
B5, B6, B7 are added to existing redemptions/qr-codes admin route files.

### Required Route Declaration Order Per File

Hono matches routes in declaration order. A param segment like `/:id` will swallow any literal segment registered after it. The following orders are **required** — deviating from them causes silent mis-routing.

**`src/routes/admin/redemptions.ts` — complete declaration order after Phase 2:**
```
1. adminRedemptions.get("/counts", requireOwner, ...)   ← literal, must be first
2. adminRedemptions.get("/recent", requireOwner, ...)   ← literal, must be before /:id
3. adminRedemptions.get("/",       requireOwner, ...)   ← list (already exists)
4. adminRedemptions.get("/:id",    requireOwner, ...)   ← param, must be last
```

**`src/routes/admin/qr-codes.ts` — declaration order after Phase 2:**
```
1. adminQrCodes.get("/counts", requireManagerOrAdmin, ...)  ← literal, must precede any /:id
2. (existing handlers below)
```

Check the existing `qr-codes.ts` for any `/:id` handlers and ensure `/counts` is declared before them.

**`src/routes/admin/merchants.ts` — no ordering issue:** The new handler is `POST /:id/toggle-active`. Since it's a POST and the existing GET `/:id` is GET, there's no collision. No ordering change needed.

**`src/routes/admin/vouchers.ts` — same as merchants:** `POST /:id/toggle-active` added alongside existing GET routes. No collision.

### Implementation Units

#### B1 — `GET /admin/overview`

**File:** `src/routes/admin/overview.ts` (new)  
**Access:** `requireManagerOrAdmin`

```ts
adminOverview.get("/overview", requireManagerOrAdmin, async (c) => {
  const [totalMerchants, totalVouchers, totalQrAvailable] = await Promise.all([
    prisma.merchant.count({ where: { isActive: true, deletedAt: null } }),
    prisma.voucher.count({ where: { isActive: true, deletedAt: null } }),
    prisma.qrCode.count({ where: { status: "AVAILABLE" } }),
  ])
  return c.json({ totalMerchants, totalVouchers, totalQrAvailable })
})
```

---

#### B2 — `GET /admin/categories`

**File:** `src/routes/admin/overview.ts` (same file as B1)  
**Access:** `requireAdmin` (all roles — no additional middleware needed; sub-app already guards)

```ts
adminOverview.get("/categories", async (c) => {
  return c.json({
    categories: ["kuliner", "hiburan", "event", "kesehatan", "lifestyle", "lainnya"]
  })
})
```

No DB query — hardcoded from the `MerchantCategory` enum values.

**Registration in `src/app.ts`:**  
Mount the overview router at the admin level:
```ts
admin.route("/", adminOverviewRoutes)  // handles /overview and /categories
```

---

#### B3 — `POST /admin/merchants/:id/toggle-active`

**File:** `src/routes/admin/merchants.ts`  
**Access:** `requireManager`

```ts
adminMerchants.post("/:id/toggle-active", requireManager, async (c) => {
  const id = c.req.param("id")
  const merchant = await prisma.merchant.findFirst({
    where: { id, deletedAt: null },
  })
  if (!merchant) return c.json({ error: "Merchant not found" }, 404)
  
  const updated = await prisma.merchant.update({
    where: { id },
    data: { isActive: !merchant.isActive },
  })
  return c.json({ merchant: updated })
})
```

---

#### B4 — `POST /admin/vouchers/:id/toggle-active`

**File:** `src/routes/admin/vouchers.ts`  
**Access:** `requireManagerOrAdmin`

```ts
adminVouchers.post("/:id/toggle-active", requireManagerOrAdmin, async (c) => {
  const id = c.req.param("id")
  const adminAuth = c.get("adminAuth")
  
  const voucher = await prisma.voucher.findFirst({
    where: { id, deletedAt: null },
  })
  if (!voucher) return c.json({ error: "Voucher not found" }, 404)
  
  if (adminAuth.role === "ADMIN" && voucher.merchantId !== adminAuth.merchantId) {
    return c.json({ error: "Access denied" }, 403)
  }
  
  const updated = await prisma.voucher.update({
    where: { id },
    data: { isActive: !voucher.isActive },
  })
  return c.json({ voucher: updated })
})
```

---

#### B5 — `GET /admin/redemptions/counts`

**File:** `src/routes/admin/redemptions.ts`  
**Access:** `requireOwner`  
**Registration order:** must be before `/:id`

```ts
adminRedemptions.get("/counts", requireOwner, async (c) => {
  const [all, confirmed, pending, failed] = await Promise.all([
    prisma.redemption.count(),
    prisma.redemption.count({ where: { status: "CONFIRMED" } }),
    prisma.redemption.count({ where: { status: "PENDING" } }),
    prisma.redemption.count({ where: { status: "FAILED" } }),
  ])
  return c.json({ all, confirmed, pending, failed })
})
```

---

#### B6 — `GET /admin/redemptions/recent`

**File:** `src/routes/admin/redemptions.ts`  
**Access:** `requireOwner`  
**Registration order:** must be before `/:id`  
**Side effect:** Remove `GET /admin/analytics/recent-activity` from `src/routes/admin/analytics.ts`

```ts
adminRedemptions.get("/recent", requireOwner, async (c) => {
  const limit = Math.min(parseInt(c.req.query("limit") ?? "10"), 50)
  
  const redemptions = await prisma.redemption.findMany({
    where: { status: "CONFIRMED" },
    include: {
      voucher: {
        select: {
          title: true,
          merchant: { select: { name: true } },
        },
      },
    },
    orderBy: { confirmedAt: "desc" },
    take: limit,
  })
  
  return c.json({
    redemptions: redemptions.map((r) => ({
      id: r.id,
      userEmail: r.userEmail,
      status: r.status,
      confirmedAt: r.confirmedAt,
      voucher: r.voucher,
    })),
  })
})
```

**Remove from `src/routes/admin/analytics.ts`:** The `adminAnalytics.get("/recent-activity", ...)` handler (lines 28–47). Delete those lines entirely.

---

#### B7 — `GET /admin/qr-codes/counts`

**File:** `src/routes/admin/qr-codes.ts`  
**Access:** `requireManagerOrAdmin`

```ts
adminQrCodes.get("/counts", requireManagerOrAdmin, async (c) => {
  const adminAuth = c.get("adminAuth")
  
  // ADMIN: scoped to their merchant's vouchers; MANAGER: cross-merchant
  const merchantFilter = adminAuth.role === "ADMIN" && adminAuth.merchantId
    ? { voucher: { merchantId: adminAuth.merchantId } }
    : {}
  
  const [available, redeemed, used] = await Promise.all([
    prisma.qrCode.count({ where: { status: "AVAILABLE", ...merchantFilter } }),
    prisma.qrCode.count({ where: { status: "REDEEMED", ...merchantFilter } }),
    prisma.qrCode.count({ where: { status: "USED", ...merchantFilter } }),
  ])
  
  return c.json({ available, redeemed, used })
})
```

**Registration order:** `counts` must be registered before any `/:id` param route to avoid conflicts.

### Phase 2 Test Scenarios

| Scenario | Expected |
|----------|----------|
| GET `/admin/overview` as MANAGER | 200 `{ totalMerchants, totalVouchers, totalQrAvailable }` |
| GET `/admin/overview` as OWNER | 403 |
| GET `/admin/categories` as any role | 200 array of 6 categories |
| POST `/admin/merchants/:id/toggle-active` as MANAGER | 200 `{ merchant }` with flipped `isActive` |
| POST `/admin/merchants/:id/toggle-active` as ADMIN | 403 |
| POST `/admin/vouchers/:id/toggle-active` as ADMIN (own merchant) | 200 `{ voucher }` |
| POST `/admin/vouchers/:id/toggle-active` as ADMIN (other merchant) | 403 |
| GET `/admin/redemptions/counts` as OWNER | 200 `{ all, confirmed, pending, failed }` |
| GET `/admin/redemptions/counts` as MANAGER | 403 |
| GET `/admin/redemptions/recent` as OWNER | 200 `{ redemptions: [...] }` |
| GET `/admin/redemptions/recent?limit=5` | 200, max 5 items |
| GET `/admin/qr-codes/counts` as MANAGER | 200 cross-merchant counts |
| GET `/admin/qr-codes/counts` as ADMIN | 200 scoped to adminAuth.merchantId |
| GET `/admin/analytics/recent-activity` | 404 (removed) |
| `pnpm tsc --noEmit` | Zero errors |

---

## Phase 3 — Business Logic Corrections

**Items:** C1, C2  
**Verification gate:** `pnpm tsc --noEmit` passes; timing behavior verified manually.

### Implementation Units

#### C1 — Auto-Reconcile 30-Second Threshold

**File:** `src/routes/redemptions.ts`

The current handler at `GET /:id` runs reconcile immediately when `status === "PENDING" && txHash`. Add a time gate.

**Change:** Expand the `select` in the initial `existing` query to include `createdAt`, then check the age:

```ts
const existing = await prisma.redemption.findFirst({
  where: { id, userEmail: user.userEmail },
  select: { id: true, status: true, txHash: true, createdAt: true },  // add createdAt
})

if (existing.status === "PENDING" && existing.txHash) {
  const ageMs = Date.now() - existing.createdAt.getTime()
  if (ageMs > 30_000) {
    try {
      await reconcileRedemptionById(existing.id)
    } catch (err) {
      console.error("[GET /redemptions/:id] auto-reconcile failed:", err)
    }
  }
}
```

This is the minimum change — one `createdAt` field added to the select, one age-check condition added.

---

#### C2 — Treasury Balance Cache 60s

**File:** `src/routes/admin/analytics.ts`

Add a module-level cache variable before the route handlers:

```ts
type TreasuryCache = {
  balance: string
  tokenAddress: string
  treasuryAddress: string
  cachedAt: number
}
let treasuryCache: TreasuryCache | null = null
const TREASURY_CACHE_TTL = 60_000
```

In the handler, check cache first, then fall through to RPC call on miss:

```ts
adminAnalytics.get("/treasury-balance", async (c) => {
  const wealthContractAddress = process.env.WEALTH_CONTRACT_ADDRESS
  const devWalletAddress = process.env.DEV_WALLET_ADDRESS

  if (!wealthContractAddress || !devWalletAddress) {
    return c.json({ error: "Treasury addresses not configured" }, 400)
  }

  // Cache hit
  if (treasuryCache && Date.now() - treasuryCache.cachedAt < TREASURY_CACHE_TTL) {
    return c.json(treasuryCache)
  }

  const rpcUrl = process.env.ALCHEMY_RPC_URL
  if (!rpcUrl) {
    return c.json({
      balance: "0",
      tokenAddress: wealthContractAddress,
      treasuryAddress: devWalletAddress,
      note: "ALCHEMY_RPC_URL not configured.",
    })
  }

  try {
    // ... existing RPC call logic (unchanged) ...
    const balance = formatUnits(rawBalance, decimals)
    
    // Write to cache
    treasuryCache = { balance, tokenAddress: wealthContractAddress, treasuryAddress: devWalletAddress, cachedAt: Date.now() }
    return c.json({ balance, tokenAddress: wealthContractAddress, treasuryAddress: devWalletAddress })
  } catch (err) {
    console.error("[treasury-balance] Failed to read on-chain balance:", err)
    
    // Return stale cache on error
    if (treasuryCache) {
      return c.json({ ...treasuryCache, stale: true })
    }
    return c.json({ balance: "0", tokenAddress: wealthContractAddress, treasuryAddress: devWalletAddress, note: "Failed to read on-chain balance." })
  }
})
```

### Phase 3 Test Scenarios

| Scenario | Expected |
|----------|----------|
| GET `/api/redemptions/:id` (PENDING+txHash, age < 30s) | Returns current state, no reconcile triggered |
| GET `/api/redemptions/:id` (PENDING+txHash, age > 30s) | Reconcile fires; returns updated status |
| GET `/api/redemptions/:id` (PENDING, no txHash) | Returns current state regardless of age |
| GET `/admin/analytics/treasury-balance` (first call) | RPC call made, result cached |
| GET `/admin/analytics/treasury-balance` (second call < 60s) | Returns cached value, no RPC call |
| GET `/admin/analytics/treasury-balance` (RPC down, stale cache) | Returns stale data with `stale: true` |
| `pnpm tsc --noEmit` | Zero errors |

---

## File Change Matrix

| File | Phase | Changes |
|------|-------|---------|
| `src/services/r2.ts` | 1 (A3) | `CLOUDFLARE_ACCOUNT_ID` → `R2_ACCOUNT_ID` |
| `src/routes/webhook.ts` | 1 (A1) | HMAC verification with `timingSafeEqual`; `c.req.text()` + `JSON.parse` |
| `src/schemas/voucher.ts` | 1 (A2) | Remove `wealthPriceIdr` from `redeemVoucherSchema` |
| `src/routes/vouchers.ts` | 1 (A2) | Remove `wealthPriceIdr` from body; update `initiateRedemption` call; 503 for price errors |
| `src/services/redemption.ts` | 1 (A2) | Remove `wealthPriceIdr` param; add `getWealthPrice()` call before tx |
| `src/routes/admin/redemptions.ts` | 1 (D1) + 2 (B5, B6) | Add `requireOwner` to existing handlers; add `/counts` and `/recent` endpoints |
| `src/routes/admin/overview.ts` | 2 (B1, B2) | New file — overview + categories endpoints |
| `src/routes/admin/merchants.ts` | 2 (B3) | Add `/merchants/:id/toggle-active` handler |
| `src/routes/admin/vouchers.ts` | 2 (B4) | Add `/vouchers/:id/toggle-active` handler |
| `src/routes/admin/qr-codes.ts` | 2 (B7) | Add `/qr-codes/counts` handler |
| `src/routes/admin/analytics.ts` | 2 (B6 side) | Remove `recent-activity` handler |
| `src/app.ts` | 2 | Register `adminOverviewRoutes` |
| `src/routes/redemptions.ts` | 3 (C1) | Add `createdAt` to select; age-gate reconcile at 30s |
| `src/routes/admin/analytics.ts` | 3 (C2) | Add module-level treasury cache; check/write in handler |

**New files:** `src/routes/admin/overview.ts`  
**No schema changes.** No new dependencies.

---

## Risks & Notes

**Route ordering (B5, B6, B7) — explicit required order documented above:** See "Required Route Declaration Order Per File" in Phase 2. The full ordered lists for `adminRedemptions` and `adminQrCodes` are non-negotiable. Verify the file after implementation by reading the handler declarations top-to-bottom and confirming literals precede all param routes.

**Webhook stream consumed (A1) — step order is non-negotiable:** `c.req.text()` must be the first statement in the handler body. `c.req.json()` must not appear anywhere in the updated handler — replace it with `JSON.parse(rawBody)`. The step-by-step order is documented under A1 above.

**Price fetch before TX (A2) — call site is non-negotiable:** `getWealthPrice()` must be called between the idempotency check and the `prisma.$transaction()` open. The closure captures `priceIdr` so the transaction body never makes a network call. The exact call-site is documented in the Step C / Step D pseudocode under A2 above.

**`recent-activity` path rename — coordinated deploy required (B6):**  
`GET /api/admin/analytics/recent-activity` is a breaking change for any back-office client currently consuming this endpoint. The back-office must be updated to call `/api/admin/redemptions/recent` before or simultaneously with the backend deployment that removes the old handler.

**Deploy strategy: backend and back-office must go live together in the same deploy window — not sequentially.** If backend deploys first, back-office breaks immediately. If back-office deploys first against the old backend, the new path returns 404 until backend catches up.

Concrete plan:
1. Update back-office to use `/api/admin/redemptions/recent` (dev/staging)
2. Merge backend + back-office changes to their respective main branches on the same day
3. Deploy backend first in the same release window, then back-office within minutes — or use a feature flag / parallel endpoint period if a hard cutover is not possible

**`requireOwner` + `requireAdmin` together (D1):** The admin sub-app in `app.ts` applies `requireAdmin` globally. Adding `requireOwner` inside `adminRedemptions` handlers runs both in sequence — `requireAdmin` sets `adminAuth`, then `requireOwner` checks `adminAuth.role === "OWNER"`. This is correct and intentional.

**Treasury cache scope (C2):** The module-level cache is process-scoped. In multi-process deployments (e.g., PM2 cluster mode), each worker has its own cache. This is acceptable per the brief — no Redis required.

## Sources

- Origin document: `docs/brainstorms/2026-05-04-backend-brief-alignment-requirements.md`
- Brief source of truth: `docs/brief/Wealth-Backend-Brief.md`
- Middleware hierarchy: `src/middleware/auth.ts`
- Admin route registration: `src/app.ts:61–71`
- Price service pattern: `src/services/price.ts` (module-level cache, `getWealthPrice()` signature)
- Redemption service: `src/services/redemption.ts` (transaction structure, QR flow)
