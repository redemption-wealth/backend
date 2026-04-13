---
title: "feat: Admin Role Restructure, QR Auto-Generation & Scan System"
type: feat
status: active
date: 2026-04-13
origin: docs/brainstorms/2026-04-13-admin-roles-qr-system-requirements.md
---

# feat: Admin Role Restructure, QR Auto-Generation & Scan System

## Overview

This plan restructures the admin role system from two roles (`owner`, `admin`) to three (`owner`, `manager`, `admin`), introduces system-generated QR codes that replace the manual ZIP upload workflow, adds a physical voucher validation endpoint for merchant admins, and hardens authentication by re-validating admin identity on every request.

**Delivered in 7 phases.** Each phase ends with a full test run, type-check build, error resolution, and a set of small commits. A single feature branch `feat/admin-roles-qr-system` is created before Phase 1 begins.

> **Note on "lint":** This project has no ESLint configuration. The type-check pass (`pnpm build`, which runs `tsc`) serves as the lint equivalent throughout all phases.

## Problem Frame

Admins currently have no merchant-level scoping — all admins can see and manage all merchants. QR codes must be manually prepared and uploaded as ZIP files, creating operational overhead. Deactivating an admin account has no immediate effect on their existing JWT tokens. These three gaps make the system unsuitable for deploying merchant-specific staff accounts and leave security posture weaker than necessary. (See origin: `docs/brainstorms/2026-04-13-admin-roles-qr-system-requirements.md`)

## Requirements Trace

- R1–R4a: Three-role system (owner / manager / admin)
- R5–R8a: Account management — owner-only control, full CRUD, merchantId assignment
- R9: DB check on every authenticated request
- R10–R14: Permission enforcement per role
- R15–R21: QR auto-generation at redemption initiation, failure cleanup
- R22–R28: QR scan endpoint with rate limiting and atomic update
- R29–R30: Remove ZIP upload and mark-used endpoints

## Scope Boundaries

- No frontend changes — backend API only
- One admin → one merchant at a time (no multi-merchant per admin)
- No QR code expiry
- No offline scan verification
- Webhook signature verification is out of scope for this plan (pre-existing gap, tracked separately)

## Context & Research

### Relevant Code and Patterns

| Concern | File |
|---|---|
| Auth middleware | `src/middleware/auth.ts` |
| Rate limit factory | `src/middleware/rate-limit.ts` |
| App wiring | `src/app.ts` |
| Admin CRUD routes | `src/routes/admin/admins.ts` |
| QR code routes | `src/routes/admin/qr-codes.ts` |
| Voucher routes (ZIP upload) | `src/routes/admin/vouchers.ts` |
| Merchant routes | `src/routes/admin/merchants.ts` |
| Analytics routes + service | `src/routes/admin/analytics.ts`, `src/services/analytics.ts` |
| Redemption service | `src/services/redemption.ts` |
| R2 service | `src/services/r2.ts` |
| Prisma schema | `prisma/schema.prisma` |
| Admin Zod schema | `src/schemas/admin.ts` |
| QR code Zod schema | `src/schemas/qr-code.ts` |
| Integration test setup | `tests/setup.integration.ts` |
| Test auth helpers | `tests/helpers/auth.ts` |
| Test fixtures | `tests/helpers/fixtures.ts` |
| Existing integration tests | `tests/integration/routes/admin/qr-codes.test.ts`, `tests/integration/routes/admin/admins.test.ts` |

### Key Existing Patterns to Follow

- **Rate limiter:** `createRateLimiter({ maxAttempts, windowMs, keyFn })` factory in `src/middleware/rate-limit.ts`
- **Owner guard:** `requireOwner` middleware in `src/middleware/auth.ts` — exact same shape needed for `requireManager`
- **DB check in auth:** `requireUser` in `src/middleware/auth.ts` already does a `prisma.user.findUnique` after JWT verify — `requireAdmin` must mirror this
- **Atomic conditional update:** use `prisma.qrCode.updateMany({ where: { id, status: 'assigned' } })` and check `count` to prevent TOCTOU race on scan
- **Transaction + R2 pattern:** `src/routes/admin/vouchers.ts` upload-qr handler shows R2 upload → DB insert → rollback on failure
- **Admin test tokens:** `tests/helpers/auth.ts` exports `createTestAdminToken`, `createTestOwnerToken` — new `createTestManagerToken` needed

### Institutional Learnings

No `docs/solutions/` directory exists yet. Patterns derived from codebase directly.

## Key Technical Decisions

- **QR token format:** `crypto.randomBytes(16).toString('hex')` — 128-bit opaque hex string stored raw in `QrCode.token` column. Admin-only scan means full HMAC signing is unnecessary overhead.
- **R2 key for generated QRs:** `qr-codes/{redemptionId}/{index}.png` — deterministic from redemption context, enabling idempotent retries (re-upload overwrites rather than creates orphan).
- **QR generation timing:** At `initiateRedemption()`, not at blockchain confirmation — frontend uses `useSimulate` (wagmi) to validate before calling. User sees QR immediately. `failRedemption()` deletes QR if blockchain fails.
- **DB check in requireAdmin:** Fetch full `Admin` record from DB on every authenticated request (mirrors `requireUser` pattern). Context is populated from the DB record, not the JWT payload. Ensures deactivation and reassignment take effect instantly.
- **Analytics scoping:** Add optional `merchantId` parameter to all 6 analytics service functions; pass `adminAuth.merchantId` when role is `admin`, otherwise `undefined` for platform-wide.
- **Enum migration:** `ALTER TYPE "AdminRole" ADD VALUE 'manager'` first, then data migration (`UPDATE admins SET role = 'manager' WHERE role = 'admin'`), then remove `admin` value via type replacement. Handled in one Prisma migration with raw SQL.
- **ZIP upload removal:** Atomic with auto-generation shipping — both removed in this plan, no interim state.

## Open Questions

### Resolved During Planning

- *QR token format:* Opaque 128-bit random hex — see Key Technical Decisions
- *Generate at initiation vs confirmation:* At initiation (useSimulate approach) — see requirements Key Decisions
- *Admin merchantId reassignment:* Owner can update via PUT /api/admin/admins/:id — covered in Phase 3
- *Rate limit key:* adminId (authenticated identity), not IP — 60 req/min per adminId

### Deferred to Implementation

- Exact Prisma `$transaction` boundary inside `initiateRedemption` after QR generation is wired — implementer should verify rollback works end-to-end with a failing R2 mock in integration test
- Whether `confirmRedemption` stock decrement hardcoded as `1` is intentional or a pre-existing bug — out of scope, note for future fix
- Orphaned pending redemptions (no txHash submitted) cleanup policy — out of scope for this plan

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

### Role Permission Matrix

| Capability | owner | manager | admin |
|---|:---:|:---:|:---:|
| Manage admin accounts | ✓ | — | — |
| App / fee settings | ✓ | — | — |
| Merchants (create/edit/delete) | ✓ | ✓ | — |
| Vouchers (create/edit) | ✓ | ✓ | ✓ (own merchant) |
| QR management | ✓ | ✓ | ✓ (own merchant) |
| Scan QR | ✓ (any) | ✓ (any) | ✓ (own merchant) |
| Analytics | ✓ (all) | ✓ (all) | ✓ (own merchant) |
| Redemptions (view) | ✓ (all) | ✓ (all) | ✓ (own merchant) |

### Redemption + QR Lifecycle

```
useSimulate passes (frontend)
       ↓
POST /api/vouchers/:id/redeem  ←── blockchain tx submitted in parallel
       ↓
initiateRedemption()
  ├─ Lock voucher (FOR UPDATE)
  ├─ Check remainingStock > 0
  ├─ Generate N QR images (crypto.randomBytes → qrcode library → PNG buffer)
  ├─ Upload N PNGs to R2 → qr-codes/{redemptionId}/{1..N}.png
  └─ DB transaction:
       ├─ INSERT QrCode(token, imageUrl, imageHash, status=assigned, ...)
       └─ INSERT Redemption(status=pending, ...)
       ↓
  Response → QR shown to user immediately

Blockchain confirms → confirmRedemption()
  └─ UPDATE redemption status=confirmed, decrement stock

Blockchain fails → failRedemption()
  ├─ DELETE QrCode records from DB
  ├─ DELETE PNG files from R2
  └─ UPDATE redemption status=failed
       ↓
  User's QR is now permanently invalid (token not in DB → NOT_FOUND on scan)

User visits merchant → shows QR
       ↓
POST /api/admin/qr-codes/scan  { token }
  ├─ Rate check: 60/min per adminId
  ├─ findUnique(token, include voucher.merchantId)
  ├─ NOT_FOUND / WRONG_MERCHANT check
  └─ Atomic: updateMany WHERE status=assigned
       → status=used, usedAt, scannedByAdminId
```

### Auth DB Check Flow

```
Incoming request with Bearer token
       ↓
verifyAdminToken(jwt) → decoded.id
       ↓
prisma.admin.findUnique({ where: { id: decoded.id } })
       ↓
assert: record exists AND isActive=true
assert: record.role === decoded.role
assert: record.merchantId === decoded.merchantId (for admin role)
       ↓
c.set('adminAuth', { adminId, email, role, merchantId })  ← from DB, not JWT
       ↓
next()
```

---

## Implementation Units

### Phase 1 — Database Foundation

> *At end of phase: `pnpm build` (type-check), `pnpm test:run`, fix all errors, then create branch `feat/admin-roles-qr-system` and commit.*

---

- [ ] **1.1 — Prisma Schema Changes**

**Goal:** Add `manager` to `AdminRole` enum; add `merchantId` to `Admin`; add `token` and `scannedByAdminId` to `QrCode`.

**Requirements:** R1, R6, R17, R23 (schema prerequisites for all later phases)

**Dependencies:** None

**Files:**
- Modify: `prisma/schema.prisma`

**Approach:**
- Add `manager` to `AdminRole` enum (after `owner`, before `admin` — keep `admin` for now, it is removed in the migration)
- Add `merchantId String? @map("merchant_id")` to `Admin` with `@relation` to `Merchant` — nullable, no `onDelete` cascade (admin accounts should survive merchant deletion)
- Change `AdminRole @default(admin)` to `AdminRole @default(manager)` on the `Admin` model
- Add `token String? @unique @map("token")` to `QrCode` — nullable initially to allow existing records, mark `@unique`
- Add `scannedByAdminId String? @map("scanned_by_admin_id")` to `QrCode` with `@relation` to `Admin`
- Add `@@index([merchantId])` on `Admin`

**Test scenarios:**
- Test expectation: none — schema-only change, verified by successful `prisma generate` and migration in 1.2

**Verification:**
- `prisma generate` completes without errors
- `pnpm build` passes (TypeScript can resolve new model fields)

---

- [ ] **1.2 — Database Migration**

**Goal:** Generate and apply a Prisma migration that safely renames `admin` → `manager` in the enum, migrates all existing admin rows, and adds the new columns.

**Requirements:** R1, R8 (data migration for existing records)

**Dependencies:** 1.1

**Files:**
- Create: `prisma/migrations/<timestamp>_admin_roles_qr_system/migration.sql` (auto-generated by Prisma, then manually edited)

**Approach:**
- Run `pnpm db:migrate --name admin_roles_qr_system` to generate the base migration SQL
- Edit the generated SQL to include the safe enum rename sequence:
  1. `ALTER TYPE "AdminRole" ADD VALUE 'manager';`
  2. `UPDATE "admins" SET role = 'manager' WHERE role = 'admin';`
  3. Create new enum type without `admin`, swap columns, drop old type — OR defer removal of `admin` value if PostgreSQL version does not support it cleanly (the `admin` value becoming unused is acceptable; the important thing is data is migrated)
- The `merchantId` column on `admins` is added as `NULL`-able — no backfill needed
- The `token` column on `qr_codes` is added as `NULL`-able — existing upload-flow records have no token (they use a different verification path that will be removed)
- The `scanned_by_admin_id` column on `qr_codes` is added as `NULL`-able

**Test scenarios:**
- Integration: after migration, existing `admin`-role records now have `role = 'manager'`
- Integration: new admin created via API defaults to `manager` role
- Integration: `merchantId` is null for existing records, settable on new admin-role accounts

**Verification:**
- `pnpm db:migrate` applies cleanly on a clean DB
- `pnpm db:seed` (if applicable) still works
- `pnpm build` passes after `prisma generate`

---

### Phase 2 — Auth & Middleware

> *At end of phase: `pnpm build`, `pnpm test:run`, fix all errors, commit.*

---

- [ ] **2.1 — Update AdminAuth Type, JWT Functions, and Startup Secret Assert**

**Goal:** Extend `AdminAuth` to carry `merchantId`; update `createAdminToken` and `verifyAdminToken` to handle three roles; fail fast on missing `ADMIN_JWT_SECRET`.

**Requirements:** R1, R8, R9 (type foundation for all auth changes)

**Dependencies:** 1.1

**Files:**
- Modify: `src/middleware/auth.ts`
- Modify: `src/schemas/admin.ts`
- Test: `tests/unit/middleware/auth.test.ts`

**Approach:**
- Update `AdminAuth.role` union: `'owner' | 'manager' | 'admin'`
- Add `merchantId?: string` to `AdminAuth`
- Update `createAdminToken` payload to include `merchantId`
- Update `verifyAdminToken` return type to match new `AdminAuth` shape
- Remove `|| 'change-me'` fallback for `ADMIN_JWT_SECRET`; throw at startup if absent (`if (!process.env.ADMIN_JWT_SECRET) throw new Error(...)` in the module initialization)
- Update `createAdminSchema` in `src/schemas/admin.ts`: `role` enum → `z.enum(['owner', 'manager', 'admin']).default('manager')`

**Patterns to follow:** `requireUser` for DB check shape (next unit); existing `AdminAuth` type for extension pattern

**Test scenarios:**
- Unit: `createAdminToken` with `role: 'manager'` produces a JWT with `role: 'manager'` in payload
- Unit: `createAdminToken` with `role: 'admin'` and `merchantId: 'abc'` includes `merchantId` in payload
- Unit: `verifyAdminToken` with expired token returns null
- Unit: `verifyAdminToken` with wrong secret returns null
- Unit: module throws on missing `ADMIN_JWT_SECRET` (mock `process.env` in test)
- Unit: `createAdminSchema` accepts `role: 'manager'`, `role: 'admin'`, `role: 'owner'`; rejects `role: 'superadmin'`

**Verification:**
- TypeScript compiles with no errors after role union change
- Existing auth unit tests still pass

---

- [ ] **2.2 — requireAdmin with Live DB Validation**

**Goal:** `requireAdmin` middleware fetches the admin record from DB on every request, asserts `isActive`, and populates `adminAuth` context from the DB record (not the JWT payload).

**Requirements:** R9

**Dependencies:** 2.1

**Files:**
- Modify: `src/middleware/auth.ts` (`requireAdmin` function)
- Test: `tests/unit/middleware/auth.test.ts`
- Test: `tests/integration/routes/admin/admins.test.ts`
- Test: `tests/e2e/security.test.ts`

**Approach:**
- After `verifyAdminToken` succeeds, call `prisma.admin.findUnique({ where: { id: decoded.id }, select: { id, email, role, merchantId, isActive } })`
- If record is null or `isActive` is false → throw `HTTPException(401)`
- Populate `c.set('adminAuth', ...)` from the DB record values (role and merchantId from DB, not JWT)
- This is identical to how `requireUser` works — follow that exact pattern

**Patterns to follow:** `requireUser` in `src/middleware/auth.ts` (lines 82–115)

**Test scenarios:**
- Unit: valid JWT for active admin → `adminAuth` set correctly with DB values
- Unit: valid JWT for deactivated admin (isActive=false) → 401
- Unit: valid JWT for deleted admin (not in DB) → 401
- Unit: valid JWT but DB lookup throws → 500 (error propagates)
- Integration: create admin, issue token, deactivate admin via DB, call `GET /api/admin/admins` with old token → 401
- Integration: create manager admin, issue token, owner updates admin's role in DB, next request reflects new role without re-login
- E2E: deactivated admin with valid JWT is rejected on all protected routes

**Verification:**
- All existing admin integration tests still pass (active admin tokens continue to work)
- New deactivation test passes

---

- [ ] **2.3 — requireManager Middleware**

**Goal:** Add `requireManager` middleware that allows `owner` or `manager` but rejects `admin` role.

**Requirements:** R10, R14 (used to protect merchant/settings/fee routes from merchant-scoped admin)

**Dependencies:** 2.2

**Files:**
- Modify: `src/middleware/auth.ts`
- Test: `tests/unit/middleware/auth.test.ts`

**Approach:**
- Follow exact same shape as `requireOwner` — check `adminAuth.role !== 'owner' && adminAuth.role !== 'manager'` → throw `HTTPException(403, { message: 'Manager access required' })`
- Must run after `requireAdmin` (which already validated the DB record)

**Patterns to follow:** `requireOwner` in `src/middleware/auth.ts`

**Test scenarios:**
- Unit: owner role → passes
- Unit: manager role → passes
- Unit: admin (merchant-scoped) role → 403
- Unit: called without `requireAdmin` first (no `adminAuth` in context) → 403 or throws

**Verification:**
- `pnpm test:unit` passes
- `pnpm build` passes

---

### Phase 3 — Account Management

> *At end of phase: `pnpm build`, `pnpm test:run`, fix all errors, commit.*

---

- [ ] **3.1 — Admin Create: merchantId Validation**

**Goal:** When creating an `admin`-role account, `merchantId` is required and validated. For `owner`/`manager`, `merchantId` is forbidden.

**Requirements:** R6, R7

**Dependencies:** 2.3, 1.2

**Files:**
- Modify: `src/schemas/admin.ts`
- Modify: `src/routes/admin/admins.ts`
- Test: `tests/integration/routes/admin/admins.test.ts`

**Approach:**
- Update `createAdminSchema` with a Zod `.superRefine` or `.refine`: if `role === 'admin'`, `merchantId` must be a valid UUID; if `role !== 'admin'`, `merchantId` must be absent or null
- In the POST handler, after schema validation, verify the provided `merchantId` exists as an active merchant in the DB before creating the admin account — return 404 if the merchant does not exist
- Store `merchantId` on the created `Admin` record

**Patterns to follow:** Zod `.superRefine` for cross-field validation; existing `createAdminSchema` in `src/schemas/admin.ts`

**Test scenarios:**
- Integration (owner creates admin): `role: 'admin'` with valid `merchantId` → 201, admin linked to merchant
- Integration: `role: 'admin'` without `merchantId` → 400 validation error
- Integration: `role: 'admin'` with non-existent `merchantId` → 404
- Integration: `role: 'manager'` with `merchantId` supplied → 400 (merchantId not allowed for manager)
- Integration: `role: 'owner'` with `merchantId` → 400
- Integration: called by `manager` role → 403 (only owner can create admins — from R5)
- Integration: called by `admin` role → 403

**Verification:**
- Integration tests pass; existing owner-creates-admin tests unaffected

---

- [ ] **3.2 — Admin Update: isActive + merchantId Reassignment**

**Goal:** Owner can update `isActive` (any role) and `merchantId` (admin role only). Admin cannot change their own `merchantId`.

**Requirements:** R7, R7a, R7b, R8a

**Dependencies:** 3.1

**Files:**
- Modify: `src/schemas/admin.ts`
- Modify: `src/routes/admin/admins.ts`
- Test: `tests/integration/routes/admin/admins.test.ts`

**Approach:**
- Update `updateAdminSchema`: add optional `merchantId` field (UUID, nullable to unlink)
- In PUT handler: if `merchantId` is present in body AND the target admin's role is not `admin` → return 400
- If requester is not `owner` AND `merchantId` is in the body → return 403 (R7b)
- If `merchantId` is being set, verify it exists in the DB
- Allow `merchantId: null` to unlink (unlink means the admin account is no longer usable until reassigned — set `isActive: false` automatically when merchantId is set to null, or return an explicit validation error)
- The `role` field is not updatable via this endpoint (to change role, delete and recreate)

**Test scenarios:**
- Integration: owner updates `isActive: false` on any admin → succeeds
- Integration: owner updates `merchantId` on admin-role account to valid merchant → succeeds, admin's context now reflects new merchant
- Integration: owner attempts to set `merchantId` on manager-role account → 400
- Integration: admin role attempts to update their own `merchantId` → 403
- Integration: owner sets `merchantId` to non-existent UUID → 404
- Integration: manager attempts to update any admin → 403 (only owner)

**Verification:**
- All account management integration tests pass

---

- [ ] **3.3 — Admin List: Expose merchantId and Linked Merchant Info**

**Goal:** `GET /api/admin/admins` includes `merchantId` and the linked merchant's name in each admin record.

**Requirements:** R8a

**Dependencies:** 3.1

**Files:**
- Modify: `src/routes/admin/admins.ts`
- Test: `tests/integration/routes/admin/admins.test.ts`

**Approach:**
- Update the Prisma query to `include: { merchant: { select: { id: true, name: true } } }`
- Return `merchantId` and `merchant: { id, name } | null` in each admin object
- Update test auth helpers in `tests/helpers/auth.ts` to add `createTestManagerToken` following same pattern as `createTestAdminToken`

**Files:**
- Modify: `src/routes/admin/admins.ts`
- Modify: `tests/helpers/auth.ts`
- Test: `tests/integration/routes/admin/admins.test.ts`

**Test scenarios:**
- Integration: list admins — admin-role records include `merchant.name`; manager/owner records have `merchant: null`
- Integration: after reassignment (3.2), list shows updated merchant info

**Verification:**
- `pnpm test:integration` passes

---

### Phase 4 — Permission Enforcement

> *At end of phase: `pnpm build`, `pnpm test:run`, fix all errors, commit.*

---

- [ ] **4.1 — Apply requireManager to Protected Routes**

**Goal:** Routes that merchant-scoped `admin` must not access are guarded with `requireManager`.

**Requirements:** R10, R14

**Dependencies:** 2.3

**Files:**
- Modify: `src/routes/admin/merchants.ts`
- Modify: `src/routes/admin/fee-settings.ts`
- Modify: `src/routes/admin/settings.ts`
- Modify: `src/routes/admin/upload.ts`
- Test: `tests/integration/routes/admin/merchants.test.ts`

**Approach:**
- `src/routes/admin/merchants.ts`: apply `requireManager` to POST (create) and PUT (update) handlers. DELETE already has `requireOwner` — keep it.
- `src/routes/admin/fee-settings.ts`: apply `requireManager` to POST and PUT handlers (create/update fee settings). activate and DELETE already have `requireOwner` — keep.
- `src/routes/admin/settings.ts`: apply `requireOwner` to GET as well (settings expose treasury wallet address — should not be visible to merchant-scoped admins). PUT already has `requireOwner`.
- `src/routes/admin/upload.ts`: apply `requireManager` (logo upload is a merchant management concern)
- Pattern: add `.use('/*', requireManager)` at the router level, or add inline to specific handlers — follow whichever pattern the existing `requireOwner` uses in those files

**Test scenarios:**
- Integration: `admin`-role account attempts POST /api/admin/merchants → 403
- Integration: `manager`-role account creates merchant → 201
- Integration: `admin`-role account attempts PUT /api/admin/fee-settings/:id → 403
- Integration: `manager`-role account updates fee setting → 200
- Integration: `admin`-role account attempts GET /api/admin/settings → 403
- Integration: `manager` can GET /api/admin/settings → 200

**Verification:**
- Merchant-scoped admin cannot reach any of these endpoints
- Manager and owner retain full access

---

- [ ] **4.2 — Merchant-Scoped Filtering for Vouchers, QR Codes, and Redemptions**

**Goal:** When a merchant-scoped `admin` role calls listing/detail endpoints, results are filtered to their linked merchant only.

**Requirements:** R11, R12

**Dependencies:** 2.2, 3.1

**Files:**
- Modify: `src/routes/admin/vouchers.ts`
- Modify: `src/routes/admin/qr-codes.ts`
- Modify: `src/routes/admin/redemptions.ts`
- Test: `tests/integration/routes/admin/vouchers.test.ts`
- Test: `tests/integration/routes/admin/qr-codes.test.ts`
- Test: `tests/integration/routes/admin/redemptions.test.ts`

**Approach:**
- In each list/detail handler, extract `adminAuth.role` and `adminAuth.merchantId` from context
- If `role === 'admin'`: inject `where: { merchantId: adminAuth.merchantId }` (vouchers and QR codes via voucher join) into the Prisma query
- Redemptions: add `where: { voucher: { merchantId: adminAuth.merchantId } }` when role is `admin`
- For voucher create (POST): if `role === 'admin'`, override `merchantId` in the body with `adminAuth.merchantId` regardless of what was submitted (R11)
- For individual detail GET (by ID): after fetching, assert the record's `merchantId` matches `adminAuth.merchantId` if role is `admin` — return 403 otherwise

**Test scenarios:**
- Integration: admin-role creates voucher — `merchantId` is forced to their linked merchant even if a different ID is in the body
- Integration: admin-role lists vouchers — only sees vouchers for their merchant
- Integration: admin-role attempts GET /api/admin/vouchers/:id for a voucher belonging to another merchant → 403
- Integration: admin-role lists redemptions — only sees redemptions for their merchant
- Integration: manager lists all vouchers — sees all merchants' vouchers
- Integration: owner lists all vouchers — sees all

**Verification:**
- Cross-merchant data leakage is not possible for admin role

---

- [ ] **4.3 — Analytics Merchant Scoping**

**Goal:** Analytics endpoints return merchant-scoped data for admin role; platform-wide for owner/manager.

**Requirements:** R13

**Dependencies:** 2.2

**Files:**
- Modify: `src/services/analytics.ts`
- Modify: `src/routes/admin/analytics.ts`
- Test: `tests/integration/routes/admin/analytics.test.ts`

**Approach:**
- Add optional `merchantId?: string` parameter to all six analytics service functions: `getSummaryStats`, `getRedemptionsOverTime`, `getMerchantCategoryDistribution`, `getWealthVolumeOverTime`, `getTopMerchants`, `getTopVouchers`
- When `merchantId` is provided, each function scopes its DB queries via `where: { voucher: { merchantId } }` or equivalent
- In the analytics route handler, extract `adminAuth` from context: if `role === 'admin'`, pass `adminAuth.merchantId` to each service function; otherwise pass `undefined`
- Admin role cannot access `getTopMerchants` meaningfully (only sees one merchant) — return single-item array

**Test scenarios:**
- Integration: admin-role calls GET /api/admin/analytics/summary — sees only their merchant's data
- Integration: manager-role calls same endpoint — sees platform-wide data
- Integration: admin-role's summary stats match the filtered voucher/redemption counts for their merchant
- Integration: admin-role calls /analytics/top-merchants — returns only their own merchant

**Verification:**
- `pnpm test:integration` passes for analytics routes

---

### Phase 5 — QR Auto-Generation

> *At end of phase: `pnpm build`, `pnpm test:run`, fix all errors, commit.*

---

- [ ] **5.1 — QR Generator Service**

**Goal:** Create a new service that generates a QR code PNG buffer from a token string and uploads it to R2.

**Requirements:** R17, R18, R19, R20

**Dependencies:** 1.1, 1.2

**Files:**
- Create: `src/services/qr-generator.ts`
- Test: `tests/unit/services/qr-generator.test.ts`

**Approach:**
- Add `qrcode` npm package (`pnpm add qrcode` and `pnpm add -D @types/qrcode`)
- Export `generateQrCode(redemptionId: string, index: number): Promise<{ token: string, imageUrl: string, imageHash: string }>` which:
  1. Generates `token = crypto.randomBytes(16).toString('hex')`
  2. Generates PNG buffer: `qrcode.toBuffer(token, { type: 'png' })`
  3. Computes `imageHash = crypto.createHash('sha256').update(buffer).digest('hex')`
  4. Determines R2 key: `qr-codes/${redemptionId}/${index}.png`
  5. Calls `uploadFile(key, buffer, 'image/png')` from `src/services/r2.ts`
  6. Returns `{ token, imageUrl: key, imageHash }`
- Export `deleteQrFiles(imageUrls: string[]): Promise<void>` wrapping `deleteFiles` from R2 service
- R2 upload errors should propagate — caller handles rollback

**Patterns to follow:** `src/services/r2.ts` for upload/delete helpers

**Test scenarios:**
- Unit: `generateQrCode` returns object with `token` (32-char hex), `imageUrl` matching `qr-codes/{redemptionId}/{index}.png`, non-empty `imageHash`
- Unit: `generateQrCode` calls `uploadFile` with correct key and `'image/png'` content type
- Unit: if R2 `uploadFile` throws, error propagates out of `generateQrCode`
- Unit: `deleteQrFiles` calls `deleteFiles` with the provided keys

**Verification:**
- Unit tests pass; `pnpm build` passes

---

- [ ] **5.2 — Modify initiateRedemption for On-Demand QR Generation**

**Goal:** Replace QR pool pre-assignment with on-demand QR generation at redemption initiation.

**Requirements:** R16, R17, R18, R19, R20

**Dependencies:** 5.1

**Files:**
- Modify: `src/services/redemption.ts`
- Test: `tests/integration/services/redemption.test.ts`
- Test: `tests/unit/services/redemption.test.ts`

**Approach:**
- Remove the `$queryRawUnsafe` block that fetches and locks available QR codes (lines ~64–72 of `redemption.ts`)
- Remove the `"No QR codes available"` guard
- Replace with: before the DB transaction, call `generateQrCode(redemptionId, index)` N times (N = `voucher.qrPerRedemption`) to get `{ token, imageUrl, imageHash }` for each QR
- R2 uploads happen outside the DB transaction (R2 is not transactional)
- Inside the DB transaction: `prisma.qrCode.createMany(...)` with the generated values, `status: 'assigned'`, `assignedToUserId`, `redemptionId`
- If the DB transaction fails after R2 uploads succeeded: catch the error, call `deleteQrFiles(uploadedKeys)` as a compensating action, then rethrow
- The `redemptionId` is available from the Redemption record created in the same transaction — generate a UUID for it before the transaction using `crypto.randomUUID()`, pass it into both the QR key paths and the Redemption create call

**Technical design:** *(directional only)*
```
redemptionId = crypto.randomUUID()
qrData = await Promise.all(
  Array.from({ length: voucher.qrPerRedemption }, (_, i) =>
    generateQrCode(redemptionId, i + 1)
  )
)
try {
  await prisma.$transaction(async (tx) => {
    // create Redemption with the pre-generated redemptionId
    // createMany QrCodes with qrData
    // ... rest of redemption logic
  })
} catch (err) {
  await deleteQrFiles(qrData.map(q => q.imageUrl))
  throw err
}
```

**Patterns to follow:** R2 rollback pattern in `src/routes/admin/vouchers.ts` upload-qr handler

**Test scenarios:**
- Integration: successful redemption → QrCode records created with status=assigned, token set, imageUrl set
- Integration: two concurrent redemptions for a voucher with stock=1 → only one succeeds, the other gets a 409 stock exhausted error
- Integration: R2 upload fails → no Redemption record created, no QrCode records, 500 returned
- Integration: DB transaction fails after R2 upload → R2 files deleted (verify via R2 mock call count)
- Integration: `qrPerRedemption: 2` → two QrCode records created per redemption
- Unit: `generateQrCode` is called `qrPerRedemption` times

**Verification:**
- `pnpm test:integration` passes; no orphan R2 files on failure paths

---

- [ ] **5.3 — Modify failRedemption: Delete QR Instead of Reset**

**Goal:** On blockchain failure, delete generated QR codes from R2 and DB (not revert to `available`).

**Requirements:** R21

**Dependencies:** 5.2

**Files:**
- Modify: `src/services/redemption.ts`
- Test: `tests/integration/services/redemption.test.ts`

**Approach:**
- In `failRedemption`, load the linked `QrCode` records including `imageUrl`
- Call `deleteQrFiles(qrCodes.map(q => q.imageUrl))` to remove R2 objects
- Inside the DB transaction: delete the `QrCode` records (not update status — delete entirely); set Redemption `status: 'failed'`
- R2 deletion is attempted before DB transaction. If R2 delete fails, log the error and continue — the QrCode record can be cleaned up manually; the important thing is the Redemption is marked failed
- Stock is NOT decremented on initiation (unchanged from current behavior) — no stock restoration needed

**Test scenarios:**
- Integration: blockchain failure → QrCode records deleted from DB, R2 delete called with correct keys
- Integration: after failRedemption, scanning the QR token returns NOT_FOUND
- Integration: if R2 delete throws, failRedemption still marks redemption as failed and deletes DB records

**Verification:**
- `pnpm test:integration` passes

---

- [ ] **5.4 — Remove ZIP Upload Endpoint**

**Goal:** Remove `POST /api/admin/vouchers/:id/upload-qr`. Remove unused imports and dependencies.

**Requirements:** R15

**Dependencies:** 5.2 (must be working first)

**Files:**
- Modify: `src/routes/admin/vouchers.ts`
- Modify: `package.json` (remove `adm-zip` and `file-type` if not used elsewhere)
- Test: `tests/integration/routes/admin/vouchers.test.ts`

**Approach:**
- Delete the entire `upload-qr` route handler (lines ~129–373 of `vouchers.ts`) and its associated imports (`AdmZip`, `fileTypeFromBuffer`, `mkdtempSync`, etc.)
- Verify `adm-zip` and `file-type` are not used in any other file before removing from `package.json`
- Ensure no integration tests call `upload-qr` — delete or repurpose any such tests

**Test scenarios:**
- Integration: `POST /api/admin/vouchers/:id/upload-qr` → 404 (route no longer exists)

**Verification:**
- `pnpm build` passes with reduced imports
- `pnpm test:run` passes

---

### Phase 6 — QR Scan Endpoint

> *At end of phase: `pnpm build`, `pnpm test:run`, fix all errors, commit.*

---

- [ ] **6.1 — Scan Rate Limiter**

**Goal:** Add a `qrScanLimiter` to the rate limit middleware — 60 requests per minute keyed by `adminId`.

**Requirements:** R23

**Dependencies:** 2.2

**Files:**
- Modify: `src/middleware/rate-limit.ts`
- Test: `tests/unit/middleware/rate-limit.test.ts`

**Approach:**
- Add `export const qrScanLimiter = createRateLimiter({ maxAttempts: 60, windowMs: 60_000, keyFn: async (c) => { const auth = c.get('adminAuth'); return \`qr-scan:${auth?.adminId ?? 'unknown'}\`; } })`
- Key on `adminId` (authenticated identity), not IP — requires `requireAdmin` to run first

**Patterns to follow:** Existing `loginLimiter` in `src/middleware/rate-limit.ts`

**Test scenarios:**
- Unit: 60 requests within 1 minute → all pass; 61st request → 429
- Unit: requests from different adminIds are counted independently
- Unit: window resets after `windowMs` elapses

**Verification:**
- Unit tests pass

---

- [ ] **6.2 — QR Scan Endpoint**

**Goal:** Implement `POST /api/admin/qr-codes/scan` — validates a decoded QR token, enforces merchant ownership for admin role, atomically marks as used.

**Requirements:** R22, R23, R24, R25, R26, R27

**Dependencies:** 6.1, 5.2

**Files:**
- Modify: `src/routes/admin/qr-codes.ts`
- Modify: `src/schemas/qr-code.ts`
- Test: `tests/integration/routes/admin/qr-codes.test.ts`

**Approach:**
- Add `scanQrSchema = z.object({ token: z.string().min(1) })` to `src/schemas/qr-code.ts`
- Add route `POST /scan` (must appear before `/:id` parameterized routes to avoid routing conflicts)
- Apply `qrScanLimiter` inline before the handler
- Handler logic:
  1. Validate body with `scanQrSchema`
  2. Single Prisma query: `prisma.qrCode.findUnique({ where: { token }, include: { voucher: { select: { merchantId: true } } } })`
  3. If null → return `{ error: 'NOT_FOUND' }` with 404
  4. If `adminAuth.role === 'admin'` and `qrCode.voucher.merchantId !== adminAuth.merchantId` → return `{ error: 'WRONG_MERCHANT' }` with 403
  5. Atomic update: `prisma.qrCode.updateMany({ where: { id: qrCode.id, status: 'assigned' }, data: { status: 'used', usedAt: new Date(), scannedByAdminId: adminAuth.adminId } })`
  6. If `count === 0` → re-fetch status; if `used` → return `{ error: 'ALREADY_USED' }` with 409; if `available` → 422 (legacy QR not applicable)
  7. On success (count = 1) → return `{ success: true, voucherId, usedAt, scannedByAdminId }`

**Test scenarios:**
- Integration: admin-role scans valid assigned QR for their merchant → 200, status=used, scannedByAdminId set
- Integration: admin-role scans valid QR belonging to different merchant → 403 WRONG_MERCHANT
- Integration: owner scans any QR regardless of merchant → 200
- Integration: manager scans any QR → 200
- Integration: scan already-used QR → 409 ALREADY_USED
- Integration: scan non-existent token → 404 NOT_FOUND
- Integration: two simultaneous scan requests for same token → exactly one succeeds with 200, other gets 409 ALREADY_USED
- Integration: scan QR for a failed redemption (token deleted) → 404 NOT_FOUND
- Integration: 61 requests in 60 seconds from same adminId → 61st returns 429

**Verification:**
- `pnpm test:integration` passes for all scan scenarios
- No double-redemption possible under concurrency

---

- [ ] **6.3 — Remove mark-used Endpoint**

**Goal:** Remove `POST /api/admin/qr-codes/:id/mark-used`. Scan endpoint is now the sole path to `used` status.

**Requirements:** R30

**Dependencies:** 6.2 (scan must be working)

**Files:**
- Modify: `src/routes/admin/qr-codes.ts`
- Test: `tests/integration/routes/admin/qr-codes.test.ts`

**Approach:**
- Delete the `/:id/mark-used` route handler
- Update or remove any integration tests that called this endpoint

**Test scenarios:**
- Integration: `POST /api/admin/qr-codes/:id/mark-used` → 404

**Verification:**
- `pnpm test:run` passes; no tests reference mark-used

---

### Phase 7 — Documentation

> *At end of phase: `pnpm build`, `pnpm test:run` (confirm still green), commit.*

---

- [ ] **7.1 — Update API_DOCUMENTATION.md**

**Goal:** Reflect all new, changed, and removed endpoints in the API reference.

**Requirements:** All

**Dependencies:** Phases 1–6 complete

**Files:**
- Modify: `docs/API_DOCUMENTATION.md`

**Approach:**
- Add new endpoints: `POST /api/admin/qr-codes/scan`, updated `POST /api/admin/admins`, updated `PUT /api/admin/admins/:id`
- Mark removed endpoints: `POST /api/admin/vouchers/:id/upload-qr`, `POST /api/admin/qr-codes/:id/mark-used`
- Update authentication section: document three-role system and what each role can access
- Update QrCode schema documentation: add `token`, `scannedByAdminId` fields
- Update Admin schema documentation: add `merchantId`, new role enum values
- Document rate limiting on scan endpoint

**Test expectation:** none — documentation only

**Verification:**
- All endpoint descriptions match implemented behavior

---

- [ ] **7.2 — Update ARCHITECTURE.md**

**Goal:** Reflect the new role hierarchy, QR lifecycle, and auth DB check behavior.

**Requirements:** All

**Dependencies:** 7.1

**Files:**
- Modify: `docs/ARCHITECTURE.md`

**Approach:**
- Update the admin roles section with three-role hierarchy diagram
- Update QR code lifecycle section: remove ZIP upload flow, add auto-generation and scan flows
- Update auth section: document DB re-validation on every request
- Document the new `qr-generator` service

**Test expectation:** none

**Verification:**
- ARCHITECTURE.md accurately describes the deployed system

---

- [ ] **7.3 — Create Frontend Integration Guide**

**Goal:** Create a single comprehensive document that explains business logic and integration patterns for both the user-facing app and the back-office admin panel.

**Requirements:** All (documentation deliverable)

**Dependencies:** 7.1, 7.2

**Files:**
- Create: `docs/FRONTEND_INTEGRATION_GUIDE.md`

**Approach:**

The document should cover two main sections:

**Section A — User-Facing App Integration**

For each user flow, document: what APIs to call, in what order, what data is passed, what the backend does internally, and what the frontend should handle.

Flows to cover:
1. **User authentication** — Privy login → `POST /api/auth/user-sync` → wallet sync
2. **Browse vouchers** — `GET /api/vouchers` (filters: merchant, category, search) → display
3. **View voucher detail** — `GET /api/vouchers/:id` → pricing breakdown explanation (base + app fee + gas)
4. **Redemption flow** — the full useSimulate → initiate → blockchain submit → QR display sequence:
   - What `POST /api/vouchers/:id/redeem` expects and returns
   - What to display while blockchain confirms
   - What to do on blockchain failure (QR invalidated)
   - How to display the QR image from the R2 signed URL
5. **View redemption history** — `GET /api/redemptions` → list user's redemptions
6. **Redemption detail** — `GET /api/redemptions/:id` → QR codes, status explanation

**Section B — Back Office (Admin Panel) Integration**

For each admin flow, document: role requirements, API calls, business logic, and what the UI should handle.

Flows to cover:
1. **Admin authentication** — `POST /api/auth/login` (first-login password flow), `POST /api/auth/set-password`, JWT storage and refresh strategy
2. **Account management** (owner only) — create/update/delete admins, role assignment, merchant linking
3. **Merchant management** (owner/manager) — CRUD, logo upload flow
4. **Voucher management** (owner/manager/admin) — create voucher (role-dependent merchantId), edit, deactivate
5. **QR lifecycle** — how QRs are created (auto, no upload needed), what the admin sees in QR listing
6. **Scan flow** (all roles) — what the scan menu calls (`POST /api/admin/qr-codes/scan`), how to handle each error code (`NOT_FOUND`, `WRONG_MERCHANT`, `ALREADY_USED`), what success looks like
7. **Redemption monitoring** — `GET /api/admin/redemptions`, what statuses mean, filtering
8. **Analytics** — what each analytics endpoint returns, scoping differences per role
9. **Fee settings and pricing** — how the 3-component price is calculated, what admin can change
10. **App settings** (owner only) — contract address, treasury wallet

Include a **data flow diagram** for the redemption + QR scan sequence showing both user app and back office in the same flow.

Include a **role access summary table** (same as the one in this plan's Key Technical Decisions section).

**Test expectation:** none

**Verification:**
- Document accurately describes all integration points
- Roles and permissions match implemented behavior

---

## System-Wide Impact

- **Interaction graph:** Every admin-authenticated request now performs one additional DB lookup. The `requireAdmin` middleware hits the `admins` table; ensure this table is indexed on `id` (it is — `@id @default(uuid())`).
- **Error propagation:** A deactivated admin mid-session gets a 401 on their next request. The frontend should handle 401 by clearing the stored JWT and redirecting to login.
- **State lifecycle risks:** QR codes generated in `initiateRedemption` will be orphaned in R2 if the server crashes between R2 upload and DB insert. The deterministic R2 key (`qr-codes/{redemptionId}/{index}.png`) allows idempotent retry — the same file path would be overwritten on a retry, not creating a second object.
- **API surface parity:** The `AdminAuth` context shape change (adding `merchantId`) must be consistent in all places that read `c.get('adminAuth')` — audit all admin route handlers.
- **Integration coverage:** Phase 5 `initiateRedemption` change is the highest-risk unit. Integration tests must cover both success and all failure paths (R2 fail, DB fail, concurrent stock exhaustion).
- **Unchanged invariants:** User-facing routes (`/api/vouchers`, `/api/redemptions`) are unchanged. The blockchain webhook routes are unchanged. The Privy user auth flow is unchanged.

## Risks & Dependencies

| Risk | Mitigation |
|---|---|
| PostgreSQL enum rename fails on production | Use additive migration (ADD VALUE 'manager') + data migration first; test against a DB snapshot before deploying |
| `initiateRedemption` DB transaction fails after R2 upload — orphan files | Deterministic R2 key allows idempotent retry; compensating delete on catch |
| requireAdmin DB check adds latency | Single indexed PK lookup on `admins` table — negligible (<1ms); Admin table is small |
| Concurrent QR scans result in double-use | Atomic `updateMany WHERE status='assigned'` + count check eliminates TOCTOU race |
| `qrcode` npm package unavailable or incompatible | Well-maintained package with TypeScript types (`@types/qrcode`); fallback: `qrcode-svg` or Canvas-based generation |
| Existing integration tests break due to role change | All existing `admin`-role test tokens become `manager` tokens — update `createTestAdminToken` or create `createTestManagerToken`; the old token helper can remain as an alias |
| Admin JWT tokens issued before this deploy carry old role claims | After deploy, first request fails the DB role check and returns 401, forcing re-login — acceptable and intentional |

## Documentation / Operational Notes

- **Deploy sequence:** Apply DB migration before deploying new code. The migration is backwards-compatible (new columns are nullable; existing `admin` role still exists in enum during transition).
- **Existing admin sessions:** All existing admin JWTs will be invalidated on first use after deploy (role claim `'admin'` no longer matches DB role `'manager'`). Communicate to admin users to re-login.
- **`qrcode` package:** Add to production dependencies (`pnpm add qrcode`), not dev-only.
- **R2 bucket:** No changes to bucket configuration. `wealth-qr-codes` private bucket is already in use.

## Sources & References

- **Origin document:** [docs/brainstorms/2026-04-13-admin-roles-qr-system-requirements.md](docs/brainstorms/2026-04-13-admin-roles-qr-system-requirements.md)
- Related plan: [docs/plans/2026-04-12-feat-tdd-comprehensive-test-suite-plan.md](docs/plans/2026-04-12-feat-tdd-comprehensive-test-suite-plan.md)
- R2 service: `src/services/r2.ts`
- Rate limiter pattern: `src/middleware/rate-limit.ts`
- DB check pattern (requireUser): `src/middleware/auth.ts`
- Redemption service: `src/services/redemption.ts`
