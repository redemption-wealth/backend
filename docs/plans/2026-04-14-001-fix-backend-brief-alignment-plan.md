---
title: "fix: Align Backend to Brief, DB Schema, and Backend Flow"
type: fix
status: active
date: 2026-04-14
origin: docs/brainstorms/2026-04-14-backend-alignment-brief-brainstorm.md
---

# fix: Align Backend to Brief, DB Schema, and Backend Flow

## Overview

Systematic alignment of the Hono backend to the canonical docs (brief, schema, flow).
Work is divided into four executable phases:

1. **Schema Migration** — add missing models, rename fields, fix types, add constraints
2. **Business Logic Core** — atomic voucher creation, slot/QR lifecycle, soft delete, permission fixes
3. **Endpoint Additions** — missing CRUD endpoints, filter/pagination, auth endpoints
4. **Test Suite Update** — fixtures, unit tests, integration tests for all new/fixed behavior

Each phase can be committed and deployed to staging independently.

## Problem Frame

The backend has been partially built: basic CRUD routes exist, but the core business
flow is broken because the `redemption_slots` table does not exist, voucher creation does
not generate QR codes, and soft delete is not implemented anywhere. The role-permission
matrix diverges from the brief in multiple places. Several endpoints described in the
backend flow doc are absent. TypeScript types and DB field names do not match the schema.

(see origin: `docs/brainstorms/2026-04-14-backend-alignment-brief-brainstorm.md`)

## Requirements Trace

- R1. Prisma schema matches `docs/2-database-schema.md` exactly (field names, types, relations, constraints)
- R2. Voucher creation atomically generates `total_stock` slots and `total_stock × qr_per_slot` QR codes with fee snapshots
- R3. QR scan updates slot to `fully_used` and decrements `remaining_stock` when all QRs in a slot are used
- R4. All entity deletes use soft delete (`deleted_at`); hard delete is removed
- R5. Role-permission matrix matches the brief: Manager handles fee/merchant/voucher; Owner handles accounts/config; Admin handles scan (scoped)
- R6. All missing endpoints from the brief are implemented
- R7. Existing integration tests pass after schema changes; new tests cover all new behavior
- R8. `pnpm tsc --noEmit` passes 0 errors; lint passes 0 errors

## Scope Boundaries

- No Alchemy RPC integration (wallet balance remains a stub)
- No `POST /auth/logout` or `POST /auth/refresh` (per-request DB check is sufficient for Phase 1)
- No Phase 2 items (Privy user auth, redemption_transactions, on-chain flow)
- No HTTP method changes (PUT→PATCH) — low value, breaking change
- `Category` table is kept as-is (not replaced with enum) — existing data + working feature

## Context & Research

### Relevant Code and Patterns

**Route patterns:**
- `src/routes/admin/admins.ts` — owner-only guard, Zod validation, Prisma CRUD pattern
- `src/routes/admin/fee-settings.ts` — `requireManager`, atomic `$transaction` for activation
- `src/routes/admin/vouchers.ts` — role-scoped query, merchant ownership check
- `src/routes/admin/qr-codes.ts` — `updateMany` for atomic status change, rate limiter
- `src/routes/admin/settings.ts` — singleton upsert pattern

**Schema patterns:**
- `prisma/schema.prisma` — all existing models; enums `AdminRole`, `QrStatus`
- `src/schemas/` — Zod schemas for all routes (add new schemas here)
- `src/middleware/auth.ts` — `requireOwner`, `requireManager`, `requireAdmin` guards

**Test patterns:**
- `tests/setup.integration.ts` — real PostgreSQL, `beforeEach` full table wipe
- `tests/helpers/fixtures.ts` — `createAdmin`, `createMerchant`, `createVoucherWithQrCodes`
- `tests/helpers/auth.ts` — `createTestOwnerToken`, `createTestManagerToken`, `createTestAdminToken`
- `tests/helpers/request.ts` — `jsonPost`, `jsonPut`, `authGet`, `authDelete`
- `tests/integration/routes/admin/fee-settings.test.ts` — reference for role-isolation test pattern

### Institutional Learnings

- Integration tests use real PostgreSQL, never mocked Prisma — this is the established
  testing contract and must be preserved
- `prisma.$transaction([...])` is used for atomic multi-step operations (established in
  fee-settings activation)
- `prisma.*.updateMany({ where: { id, status } })` pattern for atomic conditional updates
  (established in QR scan)
- `requireManager` allows manager AND owner (middleware hierarchy check)

## Key Technical Decisions

- **Single Prisma migration for all schema changes in Phase 1**: This is a dev/staging
  environment with no production data. One migration is cleaner than 8 incremental ones
  and easier to roll back during development.

- **Voucher creation uses `prisma.$transaction` with all slot + QR inserts**: Prevents
  partial state (voucher exists but no QRs). If slot/QR generation fails, the voucher
  is not created.

- **`prisma.createMany` for bulk slot and QR generation**: More efficient than individual
  `prisma.create` loops for potentially hundreds of rows. Prisma `createMany` is available
  in PostgreSQL.

- **QR scan atomicity**: After marking a QR as `used`, check if all QRs in the slot are
  `used` using a count query within the same `$transaction`. If so, update slot to
  `fully_used` and decrement `remaining_stock`.

- **Partial unique index for admin-merchant**: Prisma doesn't support conditional unique
  indexes natively. Use a raw SQL migration (`prisma.executeRaw` or a `*.sql` migration
  file) alongside the Prisma schema. Document in the migration comment.

- **`token` field retained on `QrCode`**: Used by the existing scan endpoint. After the
  schema fix, the QR scan should look up by `id` (UUID that is also the QR content) rather
  than `token`. The `token` field will be deprecated with a `// TODO: remove after Phase 2 migration`.

- **First-login response change from 403 to 200**: This is a breaking change for the
  back-office which currently catches 403. Coordinate: fix backend first, then back-office
  handles 200 `{ needs_password_setup: true }`.

- **Soft delete queries**: All `findMany` queries on soft-deletable models must add
  `where: { deletedAt: null }`. Use a helper constant `notDeleted = { deletedAt: null }`
  to avoid repetition.

## Open Questions

### Resolved During Planning

- **Should `token` field on QrCode be removed immediately?** No — it is used by the
  current scan endpoint and may be needed for Phase 2 webhook flow. Deprecate with a TODO.

- **Should bulk QR generation use `createMany` or individual `create` calls?** `createMany`
  — more efficient and Prisma PostgreSQL supports it. UUIDs must be pre-generated in
  application code and passed to `createMany`.

- **Should the first-login response change be coordinated with back-office fix?** Yes —
  implement backend fix and back-office fix (already planned in back-office plan) in the
  same PR or closely sequenced deployments to staging.

- **Should `Category` table be removed in favor of an enum?** No — keep as-is. The table
  is functional and removing it would require a migration and back-office changes for no
  user-visible benefit at this stage.

### Deferred to Implementation

- Exact `createMany` payload shape for bulk QR generation (depends on final `QrCode` schema)
- Whether the partial unique index can be expressed as a Prisma `@@unique` with a `where`
  clause (Prisma 5+ syntax) or requires raw SQL — verify during implementation
- Exact Zod schema changes for voucher `createVoucherSchema` after field renames

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

### Voucher Creation Atomic Flow

```
POST /admin/vouchers
    ↓
Zod validate body (basePrice, expiryDate, qrPerSlot, ...)
    ↓
Fetch system_config.appFeeRate  ← snapshot
Fetch fee_settings WHERE is_active = true ← snapshot gasFeeAmount
    ↓ 422 NO_ACTIVE_FEE if none
    ↓
Compute totalPrice = base + (base × feeRate%) + gas  [ROUND_HALF_UP 2dp]
    ↓
$transaction([
  voucher.create(basePrice, appFeeRate, gasFeeAmount, totalPrice, ...),
  redemptionSlot.createMany([{slotIndex:1}, ..., {slotIndex:N}]),
  qrCode.createMany([{slotId, qrNumber:1}, ...N×M rows])
])
    ↓
Return 201 { voucher, slotsCreated, qrCodesCreated }
```

### QR Scan Completion Flow

```
POST /admin/qr-codes/scan { token or id }
    ↓
Find qrCode by id (UUID from QR content)
Admin ownership check
Status must be 'redeemed' (not 'available' or 'used')
    ↓
$transaction([
  qrCode.update(status: used, usedAt, scannedByAdminId),
  count qrCodes in same slot WHERE status != 'used' → count
  if count == 0:
    redemptionSlot.update(status: fully_used)
    voucher.update(remainingStock: remainingStock - 1)
])
```

### Status State Machine

```
Slot:   available ──(user redeem)──▶ redeemed ──(all QRs scanned)──▶ fully_used

QR:     available ──(slot redeemed)──▶ redeemed ──(admin scan)──▶ used
```

---

## Phased Delivery

### Phase 1 — Schema Migration

- [ ] **Unit 1: Soft delete foundation — `deletedAt`, `createdBy`, partial unique index**

**Goal:** Add `deletedAt` to `Admin`, `Merchant`, `Voucher`. Add `createdBy` to `Admin`.
Add partial unique index for 1 admin ↔ 1 merchant constraint.

**Requirements:** R1, R4

**Dependencies:** None

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_soft_delete_and_constraints/migration.sql`
- Modify: `tests/setup.integration.ts` (cleanup order may need updating)

**Approach:**
- Add `deletedAt DateTime? @map("deleted_at")` to `Admin`, `Merchant`, `Voucher`
- Add `createdBy String? @map("created_by")` FK → admins to `Admin`
- For partial unique index on `Admin.merchantId`: add the index via raw SQL in the
  migration file — `CREATE UNIQUE INDEX admins_merchant_unique ON admins(merchant_id) WHERE merchant_id IS NOT NULL AND deleted_at IS NULL`
- Prisma schema gets a `@@index([merchantId])` comment noting the partial unique exists
  in the DB (Prisma doesn't render partial uniques in schema.prisma)
- Run `prisma migrate dev` to generate migration

**Test scenarios:**
- Test expectation: none — pure schema change. Verification via `prisma migrate status`
  and `pnpm tsc --noEmit`.

**Verification:**
- `prisma migrate status` shows migration applied
- `pnpm tsc --noEmit` passes

---

- [ ] **Unit 2: `redemption_slots` model and `SlotStatus` enum**

**Goal:** Add the `RedemptionSlot` model and `SlotStatus` enum that is central to the
voucher + QR lifecycle.

**Requirements:** R1, R2

**Dependencies:** Unit 1

**Files:**
- Modify: `prisma/schema.prisma`
- Modify: `prisma/migrations/<timestamp>_add_redemption_slots/migration.sql`

**Approach:**
- New enum `SlotStatus { available redeemed fully_used }`
- New model `RedemptionSlot`: `id`, `voucherId` (FK → vouchers RESTRICT), `slotIndex Int`,
  `status SlotStatus default available`, `redeemedAt DateTime?`, `createdAt`, `updatedAt`
- Unique constraint: `@@unique([voucherId, slotIndex])`
- Index: `@@index([voucherId, status])`
- Add `redemptionSlots RedemptionSlot[]` relation to `Voucher`
- Add `slot RedemptionSlot @relation(...)` to `QrCode` (added in Unit 3 — forward reference here)

**Test scenarios:**
- Test expectation: none — pure schema addition. Verification via migration + typecheck.

**Verification:**
- `prisma migrate status` clean
- `RedemptionSlot` accessible via `prisma.redemptionSlot`

---

- [ ] **Unit 3: Voucher model overhaul — fee snapshot fields, rename fields**

**Goal:** Transform `Voucher` model from `priceIdr: Int` + `endDate` + `qrPerRedemption`
to the full schema with `basePrice`, `appFeeRate`, `gasFeeAmount`, `totalPrice`,
`expiryDate`, `qrPerSlot`, `createdBy`.

**Requirements:** R1, R2

**Dependencies:** Unit 1 (deletedAt already added)

**Files:**
- Modify: `prisma/schema.prisma`
- Modify: `prisma/migrations/<timestamp>_voucher_fee_snapshot/migration.sql`
- Modify: `src/schemas/voucher.ts`
- Modify: `tests/helpers/fixtures.ts` (`createVoucherWithQrCodes` function)

**Approach:**
- Remove `priceIdr Int`
- Add: `basePrice Decimal @db.Decimal(15,2)`, `appFeeRate Decimal @db.Decimal(5,2)`,
  `gasFeeAmount Decimal @db.Decimal(15,2)`, `totalPrice Decimal @db.Decimal(15,2)`
- Rename `endDate` → `expiryDate` (migration: `ALTER TABLE vouchers RENAME COLUMN end_date TO expiry_date`)
- Rename `qrPerRedemption` → `qrPerSlot` (migration: rename column)
- Add `createdBy String? @map("created_by")` FK → admins
- Add `DB CHECK` constraint in migration SQL: `expiry_date > start_date`, `base_price >= 1000`
- Update `createVoucherSchema` Zod: rename fields, add `basePrice` (number ≥ 1000), remove `priceIdr`
- Update `updateVoucherSchema` Zod: remove `priceIdr`, keep only editable fields
  (`title`, `description`, `startDate`, `expiryDate`, `isActive`, `totalStock`)
- Update fixtures `createVoucherWithQrCodes` to use new field names

**Test scenarios:**
- Test expectation: none — schema + Zod type change. `pnpm tsc --noEmit` is the gate.

**Verification:**
- Voucher model has all fee snapshot fields in Prisma client
- `createVoucherSchema` rejects `priceIdr`, accepts `basePrice`
- `pnpm tsc --noEmit` passes

---

- [ ] **Unit 4: QrCode model overhaul — slot relationship, `redeemed` status, `slotId`**

**Goal:** Add `slotId`, `qrNumber`, `redeemedAt` to `QrCode`. Rename `QrStatus.assigned` to
`redeemed`. Add `redemptionSlots` back-relation to `Voucher` and `QrCode`.

**Requirements:** R1, R3

**Dependencies:** Unit 2 (RedemptionSlot model exists)

**Files:**
- Modify: `prisma/schema.prisma`
- Modify: `prisma/migrations/<timestamp>_qrcode_slot_relation/migration.sql`

**Approach:**
- Add `slotId String @map("slot_id")` FK → redemption_slots (RESTRICT) — NOT NULL
  for new QRs; existing rows may need migration default or nullable temporarily
- Add `qrNumber Int @map("qr_number") @db.SmallInt` — position within slot (1 or 2)
- Add `redeemedAt DateTime? @map("redeemed_at")`
- Change enum value `QrStatus.assigned` → `QrStatus.redeemed` (breaking: need migration to rename enum value in PostgreSQL)
  - PostgreSQL syntax: `ALTER TYPE "QrStatus" RENAME VALUE 'assigned' TO 'redeemed'`
- Add `@@unique([slotId, qrNumber])` on QrCode
- Add unique index `@@index([slotId])` on QrCode
- Keep `token`, `imageUrl`, `imageHash` fields with `// TODO: deprecate after Phase 2`
  comment — remove `POST /admin/qr-codes` manual create endpoint (replaces with auto-generation)

**Test scenarios:**
- Test expectation: none — schema change. Downstream behavior tested in Phase 2 units.

**Verification:**
- `QrStatus.redeemed` exists; `QrStatus.assigned` does not
- QrCode has `slotId` and `qrNumber` in Prisma client

---

- [ ] **Unit 5: AppSettings overhaul + FeeSetting Decimal fix + test infra update**

**Goal:** Rename `AppSettings` fields to match the schema, add missing config fields,
fix `FeeSetting.amountIdr` to `Decimal`. Update test fixtures and `setup.integration.ts`
for new cleanup order.

**Requirements:** R1

**Dependencies:** Units 1–4 (all schema changes in one migration or separate)

**Files:**
- Modify: `prisma/schema.prisma`
- Modify: `prisma/migrations/<timestamp>_app_settings_overhaul/migration.sql`
- Modify: `src/schemas/settings.ts`
- Modify: `tests/setup.integration.ts`
- Modify: `tests/helpers/fixtures.ts`

**Approach:**
- `AppSettings`: rename `appFeePercentage` → `appFeeRate`, `tokenContractAddress` →
  `wealthContractAddress`, `treasuryWalletAddress` → `devWalletAddress`
- `AppSettings`: add `alchemyRpcUrl String?`, `coingeckoApiKey String?`,
  `appFeeUpdatedBy String? @map("app_fee_updated_by")` FK → admins,
  `appFeeUpdatedAt DateTime? @map("app_fee_updated_at")`
- `FeeSetting`: change `amountIdr Int` → `amountIdr Decimal @db.Decimal(15,2)`
- Update `updateSettingsSchema` Zod with new field names
- Update `tests/setup.integration.ts` `beforeEach` to add
  `testPrisma.redemptionSlot.deleteMany()` before `qrCode.deleteMany()`
- Update `tests/helpers/fixtures.ts` `createAppSettings` and `createVoucherWithQrCodes`
  with new field names; add `createFeeSetting` that uses `Decimal` if needed

**Test scenarios:**
- Test expectation: none — schema + type change. Gate: `pnpm tsc --noEmit`.

**Verification:**
- `prisma.appSettings.findUnique` returns `appFeeRate`, `alchemyRpcUrl`, etc.
- All existing integration tests pass with updated fixtures

---

### Phase 2 — Business Logic Core

- [ ] **Unit 6: Pricing service + Voucher creation atomic flow**

**Goal:** Create a pure `calcTotalPrice` service. Implement `POST /admin/vouchers` to
atomically snapshot fees, compute total price, and generate slots + QR codes.

**Requirements:** R2, R8

**Dependencies:** Units 3, 4, 5 (Prisma schema has all required fields)

**Files:**
- Create: `src/services/pricing.ts`
- Modify: `src/routes/admin/vouchers.ts`
- Modify: `src/schemas/voucher.ts`
- Create: `tests/unit/services/pricing.test.ts`
- Modify: `tests/integration/routes/admin/vouchers.test.ts`

**Approach:**
- `pricing.ts` exports `calcTotalPrice(basePrice: Decimal, appFeeRate: Decimal, gasAmount: Decimal): Decimal` — pure function, ROUND_HALF_UP 2 decimal places
- `POST /admin/vouchers` handler:
  1. Validate body with updated `createVoucherSchema` (basePrice, qrPerSlot, expiryDate)
  2. Fetch `system_config.appFeeRate` (default 3.00 if singleton missing)
  3. Fetch active fee: `feeSetting WHERE is_active = true` — 422 `NO_ACTIVE_FEE` if none
  4. Compute `totalPrice` via `calcTotalPrice`
  5. Generate slot array (slotIndex 1..totalStock) and QR array (qrNumber 1..qrPerSlot per slot)
  6. Pre-generate UUIDs in application code for `qrCode.id` (these are the QR content)
  7. `$transaction([voucher.create, redemptionSlot.createMany, qrCode.createMany])`
  8. Return 201 with `{ voucher, slotsCreated: totalStock, qrCodesCreated: totalStock × qrPerSlot }`

**Patterns to follow:**
- `prisma.$transaction([...])` in `src/routes/admin/fee-settings.ts` (activation)
- `src/routes/admin/vouchers.ts` existing validation + merchant-scope pattern

**Test scenarios:**
- Happy path: POST with valid body + active fee → 201, `voucher.appFeeRate` equals system config value
- Integration: DB has `total_stock` slots and `total_stock × qrPerSlot` QR codes after creation
- Integration: voucher.totalPrice = basePrice + (basePrice × feeRate / 100) + gasAmount
- Error path: no active fee setting → 422 `NO_ACTIVE_FEE`
- Error path: `expiryDate < startDate` → 400
- Error path: `basePrice < 1000` → 400
- Error path: `totalStock < 1` → 400
- Happy path: `qrPerSlot = 2` → QR count = totalStock × 2
- Happy path: Admin role → `merchantId` forced to `adminAuth.merchantId`
- Error path: Admin POSTs with a different merchantId → overridden to assigned merchant

**Verification:**
- `pnpm test tests/integration/routes/admin/vouchers.test.ts` all pass
- `pnpm test tests/unit/services/pricing.test.ts` all pass

---

- [ ] **Unit 7: Voucher edit stok — floor constraint + slot management**

**Goal:** Implement `PUT /admin/vouchers/:id` stock update with floor constraint:
increasing stock generates new slots + QRs; decreasing below the floor is rejected.

**Requirements:** R2, R5

**Dependencies:** Unit 6 (slots and QRs exist after creation)

**Files:**
- Modify: `src/routes/admin/vouchers.ts`
- Modify: `tests/integration/routes/admin/vouchers.test.ts`

**Approach:**
- When `totalStock` is in the update body:
  - Current `totalStock` from DB vs new value
  - `floor = count(redemptionSlots WHERE voucherId AND status IN [redeemed, fully_used])`
  - If `newStock < floor` → 422 `BELOW_FLOOR`
  - If `newStock > current`: generate new slots (slotIndex from `current+1` to `newStock`)
    and QRs for each new slot — `$transaction`
  - If `newStock < current`: delete slots AVAILABLE from the end (by slotIndex DESC)
    and their QR codes — `$transaction`
  - `remainingStock = count(slots WHERE status = available)`
    (recalculate after modification)
- Fields `basePrice`, `appFeeRate`, `gasFeeAmount`, `totalPrice`, `qrPerSlot` in PATCH body
  → silently ignored (not an error)

**Patterns to follow:**
- `prisma.$transaction` in fee-settings activation
- Voucher handler merchant-scope check

**Test scenarios:**
- Happy path: increase totalStock by 5 → 5 new slots + QRs generated in DB
- Happy path: decrease totalStock above floor → correct slots deleted from end
- Error path: decrease totalStock below floor (has redeemed slots) → 422 `BELOW_FLOOR`
- Edge case: set totalStock to current value → no DB change, 200
- Edge case: attempt to update basePrice → field silently ignored, 200 with old price
- Error path: admin updating voucher not from their merchant → 403
- Error path: voucher not found → 404

**Verification:**
- DB slot count matches new `totalStock` after update
- No slots with `redeemed`/`fully_used` status were deleted

---

- [ ] **Unit 8: QR scan — slot completion + `remaining_stock` decrement**

**Goal:** Extend `POST /admin/qr-codes/scan` to look up by QR `id` (UUID), check for
`redeemed` status (not `assigned`), and after marking `used`, check slot completion and
decrement `remaining_stock`.

**Requirements:** R3

**Dependencies:** Unit 4 (QrStatus.redeemed exists, slotId on QrCode)

**Files:**
- Modify: `src/routes/admin/qr-codes.ts`
- Modify: `src/schemas/qr-code.ts`
- Modify: `tests/integration/routes/admin/qr-codes.test.ts`

**Approach:**
- `scanQrSchema`: accept `{ id: UUID }` (the UUID from QR content) — not `token`
  - Keep `token` support as fallback with `// TODO: remove after Phase 2` comment
- Lookup: `qrCode.findUnique({ where: { id } })` (primary lookup by UUID)
- Status check: must be `redeemed` (not `available`, not `used`)
  - `available` → 422 `QR_NOT_REDEEMED`
  - `used` → 409 `QR_ALREADY_USED`
- `$transaction([
    qrCode.update(status: used, usedAt, scannedByAdminId),
    count = qrCode.count(WHERE slotId AND status != used),
    if count == 0: redemptionSlot.update(slotId, status: fully_used),
    if count == 0: voucher.update(voucherId, remainingStock: { decrement: 1 })
  ])`
- Prisma transactions don't support conditional logic natively — use a service function
  that runs these steps in sequence within a single interactive transaction
  (`prisma.$transaction(async (tx) => { ... })`)
- Response: include `voucher.title`, `merchant.name` for back-office display

**Patterns to follow:**
- `prisma.$transaction(async (tx) => {...})` interactive transaction pattern
- Conditional `updateMany` pattern in existing `qr-codes.ts`

**Test scenarios:**
- Happy path: QR status `redeemed` → response 200, QR becomes `used` in DB
- Integration: last QR in slot scanned → slot becomes `fully_used`, `remaining_stock` decrements
- Integration: not last QR in slot → slot stays `redeemed`, `remaining_stock` unchanged
- Error path: QR status `available` → 422 `QR_NOT_REDEEMED`
- Error path: QR status `used` → 409 `QR_ALREADY_USED`
- Error path: QR UUID not found → 404
- Error path: admin scanning QR from a different merchant → 403
- Error path: manager attempting to scan → 403
- Edge case: `remaining_stock` does not go below 0

**Verification:**
- After scanning last QR: DB slot `status = fully_used`, voucher `remainingStock` decreased
- Manager role returns 403 on scan endpoint

---

- [ ] **Unit 9: Soft delete — all entities + voucher deletion guard**

**Goal:** Replace all `prisma.*.delete()` calls with soft delete. Add guard preventing
voucher soft-delete if active QRs exist. Add `WHERE deletedAt IS NULL` to all list queries.

**Requirements:** R4

**Dependencies:** Unit 1 (deletedAt columns exist)

**Files:**
- Modify: `src/routes/admin/admins.ts`
- Modify: `src/routes/admin/merchants.ts`
- Modify: `src/routes/admin/vouchers.ts`
- Modify: `tests/integration/routes/admin/admins.test.ts`
- Modify: `tests/integration/routes/admin/merchants.test.ts`
- Modify: `tests/integration/routes/admin/vouchers.test.ts`

**Approach:**
- Create helper constant in a shared location (or in each file): `const notDeleted = { deletedAt: null }`
- All `findMany` on Admin, Merchant, Voucher: add `where: { ...notDeleted }`
- All `findUnique` by ID: if result has `deletedAt != null` → treat as 404
- Delete endpoints:
  - Admin: `prisma.admin.update({ where: { id }, data: { deletedAt: new Date() } })`
    — validate self-delete and last-owner before, same as now
  - Merchant: same soft delete pattern
  - Voucher: before soft-delete, check `qrCode.count({ where: { voucherId: id, status: { in: [redeemed, used] } } })` → 422 `VOUCHER_HAS_ACTIVE_QR` if > 0

**Patterns to follow:**
- Existing delete route patterns in `admins.ts`, `merchants.ts`, `vouchers.ts`

**Test scenarios:**
- Happy path (admin soft delete): DELETE /admin/admins/:id → 200, admin still in DB with `deletedAt` set
- Happy path (merchant soft delete): DELETE → 200, merchant still in DB
- Happy path (voucher soft delete, no active QRs): DELETE → 200
- Error path (voucher with redeemed QR): DELETE → 422 `VOUCHER_HAS_ACTIVE_QR`
- Edge case: GET list after soft delete → deleted entity not in results
- Edge case: GET /:id after soft delete → 404
- Error path: delete last owner → 400 (unchanged)
- Error path: delete self → 400 (unchanged)

**Verification:**
- Soft-deleted entities absent from list queries
- DB row still exists with `deletedAt` timestamp set

---

- [ ] **Unit 10: Role-permission matrix fixes**

**Goal:** Change `requireOwner` to `requireManager` for fee activate/delete and
merchant delete. Fix voucher delete to allow manager + admin (scoped).

**Requirements:** R5

**Dependencies:** None (pure middleware guard change)

**Files:**
- Modify: `src/routes/admin/fee-settings.ts`
- Modify: `src/routes/admin/merchants.ts`
- Modify: `src/routes/admin/vouchers.ts`
- Modify: `tests/integration/routes/admin/fee-settings.test.ts`
- Modify: `tests/integration/routes/admin/merchants.test.ts`
- Modify: `tests/integration/routes/admin/vouchers.test.ts`

**Approach:**
- `fee-settings/:id/activate`: change `requireOwner` → `requireManager`
- `fee-settings/:id` DELETE: change `requireOwner` → `requireManager`
- `merchants/:id` DELETE: change `requireOwner` → `requireManager`
- `vouchers/:id` DELETE: remove `requireOwner`; add role check in handler — manager:
  always allowed; admin: check merchant ownership first
- Verify `requireManager` allows both manager AND owner (check middleware logic)

**Patterns to follow:**
- `requireManager` in `fee-settings.ts` (POST, PUT already use it)
- Admin ownership check in `vouchers.ts` GET /:id

**Test scenarios:**
- Happy path (manager activates fee) → 200
- Error path (owner tries to activate fee) → 403 if `requireManager` is strict to manager
  only; or 200 if middleware allows owner — verify middleware behavior first
- Happy path (manager deletes merchant) → 200
- Error path (admin tries to delete merchant) → 403
- Happy path (manager deletes voucher) → 200
- Happy path (admin deletes own-merchant voucher) → 200
- Error path (admin deletes voucher from different merchant) → 403
- Error path (owner tries to delete voucher) → 403

**Verification:**
- Manager can activate fee, delete fee, delete merchant, delete voucher
- Owner cannot do those actions (if `requireManager` is manager-only)
- Admin can delete vouchers only from their assigned merchant

---

### Phase 3 — Endpoint Additions

- [ ] **Unit 11: Admin list filter + pagination + `GET /admin/admins/:id`**

**Goal:** Add query filter (`?role=`, `?isActive=`, `?search=`), pagination, and a
GET detail endpoint for a single admin.

**Requirements:** R6

**Dependencies:** Unit 9 (soft delete adds `deletedAt` filter to queries)

**Files:**
- Modify: `src/routes/admin/admins.ts`
- Modify: `src/schemas/admin.ts`
- Modify: `tests/integration/routes/admin/admins.test.ts`

**Approach:**
- GET `/admin/admins`: add Zod query schema — `role?: AdminRole`, `isActive?: boolean`,
  `search?: string`, `page: number`, `limit: number`
- Build `where` object from query params + `deletedAt: null`
- Return `{ admins, pagination: { page, limit, total, totalPages } }`
- GET `/admin/admins/:id`: fetch single admin by ID — 404 if not found or soft-deleted
  — include `assignedMerchant: { select: { id, name } }`

**Patterns to follow:**
- Pagination pattern in `src/routes/admin/vouchers.ts`
- `merchantQuerySchema` in `src/schemas/merchant.ts`

**Test scenarios:**
- Happy path: GET list → `{ admins: [...], pagination }`
- Happy path: `?role=admin` → only admin rows returned
- Happy path: `?isActive=false` → only inactive admins
- Happy path: `?search=manager@` → filtered by email substring
- Happy path: GET /:id → single admin with `assignedMerchant`
- Error path: GET /:id not found → 404
- Error path: GET /:id soft-deleted → 404
- Error path: non-owner calls GET list → 403

**Verification:**
- Filter combinations return correct results
- Pagination object includes correct `total` count

---

- [ ] **Unit 12: `POST /admin/admins/:id/reset-password`**

**Goal:** Owner sets `passwordHash = null` for another admin (triggers first-login flow
on next login). Guards: owner only, cannot reset self, cannot reset last active owner.

**Requirements:** R6

**Dependencies:** None

**Files:**
- Modify: `src/routes/admin/admins.ts`
- Modify: `tests/integration/routes/admin/admins.test.ts`

**Approach:**
- POST `/admin/admins/:id/reset-password` behind `requireOwner`
- Fetch target admin — 404 if not found or soft-deleted
- Guard: if `target.id == currentAdmin.adminId` → 400 `CANNOT_RESET_SELF`
- Guard: if `target.role == owner && ownerCount <= 1` → 400 `CANNOT_RESET_LAST_OWNER`
- `prisma.admin.update({ where: { id }, data: { passwordHash: null } })`
- Response: `{ ok: true }`

**Patterns to follow:**
- Self-delete and last-owner guards in existing DELETE admin handler

**Test scenarios:**
- Happy path: owner resets another admin's password → 200, `passwordHash = null` in DB
- Error path: reset self → 400 `CANNOT_RESET_SELF`
- Error path: reset last active owner → 400 `CANNOT_RESET_LAST_OWNER`
- Error path: admin ID not found → 404
- Error path: non-owner caller → 403
- Integration: after reset, admin's next login returns first-login response

**Verification:**
- Target admin's `passwordHash` is null after successful reset
- Guards prevent self-reset and last-owner reset

---

- [ ] **Unit 13: `PATCH /auth/change-password` + fix first-login response**

**Goal:** Add self-service password change endpoint. Fix login response for first-login
from 403 to 200 `{ needs_password_setup: true }`.

**Requirements:** R6

**Dependencies:** None

**Files:**
- Modify: `src/routes/auth.ts`
- Modify: `src/schemas/auth.ts`
- Modify: `tests/integration/routes/auth.test.ts`

**Approach:**
- `POST /auth/login` first-login: change response from
  `c.json({ error, code: "PASSWORD_NOT_SET" }, 403)` to
  `c.json({ needs_password_setup: true, email: admin.email }, 200)`
- `PATCH /auth/change-password` behind `requireAdmin`:
  - Schema: `{ currentPassword: string, newPassword: string (min 8) }`
  - Verify `bcryptjs.compare(currentPassword, admin.passwordHash)` → 401 if wrong
  - Hash `newPassword`, `prisma.admin.update({ passwordHash: hash })`
  - Response: `{ message: "Password berhasil diubah" }`

**Patterns to follow:**
- `POST /auth/set-password` pattern (bcrypt hash, admin update)
- `requireAdmin` middleware

**Test scenarios:**
- Happy path (first-login): POST /auth/login with null passwordHash → 200 `{ needs_password_setup: true, email }`
- Happy path (change-password): valid currentPassword + new password → 200
- Error path (change-password): wrong currentPassword → 401
- Error path (change-password): newPassword < 8 chars → 400
- Error path (change-password): no auth → 401
- Integration: after change-password, old password no longer works for login

**Verification:**
- Login with null passwordHash returns 200, not 403
- `PATCH /auth/change-password` updates the hash in DB

---

- [ ] **Unit 14: `GET /admin/merchants/:id` + `GET /admin/merchants/select`**

**Goal:** Add detail endpoint for a single merchant, and a dropdown list endpoint for
owner-side admin assignment.

**Requirements:** R6

**Dependencies:** Unit 9 (soft delete queries)

**Files:**
- Modify: `src/routes/admin/merchants.ts`
- Modify: `tests/integration/routes/admin/merchants.test.ts`

**Approach:**
- `GET /admin/merchants/:id`: behind `requireAdmin` (any authenticated admin)
  - Fetch merchant `WHERE id AND deletedAt IS NULL`
  - Admin role: check `merchant.id == adminAuth.merchantId` → 403 if mismatch
  - Include: `category: { select: { name } }`, `creator: { select: { email } }`
  - 404 if not found or soft-deleted
- `GET /admin/merchants/select`: behind `requireOwner`
  - Returns only merchants that are active AND have no currently-assigned admin
    (`Admin WHERE merchantId = merchant.id AND isActive = true AND deletedAt IS NULL`)
  - Response: `[{ id, name }]` — no pagination (small dropdown)
  - Note: place `/select` route before `/:id` in Hono to prevent param capture

**Patterns to follow:**
- GET detail pattern in `vouchers.ts` (GET /:id with admin scope check)
- List query with pagination in existing merchant list

**Test scenarios:**
- Happy path (GET /:id as manager): returns merchant with category + creator
- Happy path (GET /:id as admin, own merchant): returns merchant
- Error path (GET /:id as admin, different merchant): 403
- Error path (GET /:id soft-deleted): 404
- Happy path (GET /select as owner): returns unassigned active merchants
- Error path (GET /select as manager): 403

**Verification:**
- `GET /admin/merchants/:id` returns full merchant detail
- `GET /admin/merchants/select` returns only unassigned merchants

---

- [ ] **Unit 15: Settings API update — rename + add `alchemyRpcUrl`, `coingeckoApiKey`**

**Goal:** Update GET and PUT settings to use correct field names and expose the two new
config fields.

**Requirements:** R6

**Dependencies:** Unit 5 (AppSettings schema renamed)

**Files:**
- Modify: `src/routes/admin/settings.ts`
- Modify: `src/schemas/settings.ts`
- Modify: `tests/integration/routes/admin/settings.test.ts`

**Approach:**
- `updateSettingsSchema`: rename fields to `appFeeRate`, `wealthContractAddress`,
  `devWalletAddress`; add optional `alchemyRpcUrl: string`, `coingeckoApiKey: string`
- `appFeeRate` validation: number between 0 and 50 (CHECK from schema)
- `devWalletAddress` validation: `0x` followed by exactly 40 hex chars (regex)
- Update handler to use new Prisma field names
- When `appFeeRate` is updated: also set `appFeeUpdatedBy: adminAuth.adminId`,
  `appFeeUpdatedAt: new Date()`

**Patterns to follow:**
- Existing settings upsert pattern in `src/routes/admin/settings.ts`

**Test scenarios:**
- Happy path: GET settings → includes `alchemyRpcUrl`, `coingeckoApiKey`
- Happy path: PUT with `alchemyRpcUrl` → persisted
- Happy path: PUT `appFeeRate = 5` → `appFeeUpdatedAt` is set in DB
- Error path: `appFeeRate > 50` → 400
- Error path: `devWalletAddress` not `0x...40hex` → 400
- Error path: non-owner caller → 403

**Verification:**
- GET returns all new fields
- Fee audit fields (`appFeeUpdatedBy`, `appFeeUpdatedAt`) populated when fee changes

---

### Phase 4 — Test Suite

- [ ] **Unit 16: Unit tests — pricing service + Zod schema validation**

**Goal:** Cover the pure `calcTotalPrice` function and critical Zod schemas with unit
tests that run without a database.

**Requirements:** R7, R8

**Dependencies:** Unit 6 (pricing.ts created)

**Files:**
- Create: `tests/unit/services/pricing.test.ts`
- Create: `tests/unit/schemas/voucher.test.ts`
- Create: `tests/unit/schemas/settings.test.ts`

**Approach:**
- `pricing.test.ts`: test all price calculation scenarios including rounding edge cases
- `voucher.test.ts`: `createVoucherSchema` valid + invalid cases; `updateVoucherSchema`
  read-only field ignore behavior
- `settings.test.ts`: `appFeeRate` range, `devWalletAddress` regex, `alchemyRpcUrl` optional

**Test scenarios:**
- `calcTotalPrice(50000, 3, 500)` → 52000.00
- `calcTotalPrice(100000, 0, 0)` → 100000.00
- `calcTotalPrice(10000, 10, 2000)` → 13000.00
- `calcTotalPrice(1000, 3.5, 500)` → rounding: 1000 + 35.00 + 500 = 1535.00
- `createVoucherSchema`: valid → passes; `expiryDate < startDate` → fails; `basePrice = 999` → fails; `qrPerSlot = 3` → fails
- `updateVoucherSchema`: `basePrice` in payload → field ignored (not present in parsed output)
- `updateSettingsSchema`: `appFeeRate = 51` → fails; `devWalletAddress = "0xGGGG"` → fails

**Verification:**
- `pnpm test tests/unit` all pass with 0 failures

---

- [ ] **Unit 17: Integration tests — auth, admins, fee-settings**

**Goal:** Update and extend integration tests for auth endpoints (including new
change-password and fixed first-login), admin endpoints (filter, pagination, reset-password),
and fee-settings (corrected role guards).

**Requirements:** R7

**Dependencies:** Units 9–13

**Files:**
- Modify: `tests/integration/routes/auth.test.ts`
- Modify: `tests/integration/routes/admin/admins.test.ts`
- Modify: `tests/integration/routes/admin/fee-settings.test.ts`

**Approach:**
- Auth tests: add first-login → 200, change-password success + failure cases
- Admin tests: add filter/pagination cases, GET /:id, reset-password, soft-delete verification
- Fee-settings tests: change owner-based tests to manager-based (role guard fix)

**Test scenarios:** (see §5.3 of origin brainstorm for complete table)

Key additions:
- First-login: `passwordHash = null` → POST login → 200 `{ needs_password_setup: true }`
- Change-password: wrong current → 401; too short → 400; success → 200
- Admin list: `?role=admin` returns only admin rows; pagination total correct
- Admin reset-password: target `passwordHash` is null in DB after success
- Fee activate: manager token → 200; owner token → check if 403 or 200 (per middleware)

**Verification:**
- `pnpm test tests/integration/routes/auth.test.ts` all pass
- `pnpm test tests/integration/routes/admin/admins.test.ts` all pass
- `pnpm test tests/integration/routes/admin/fee-settings.test.ts` all pass

---

- [ ] **Unit 18: Integration tests — vouchers, QR scan, slot lifecycle**

**Goal:** Test the full voucher creation flow (fee snapshot + slot generation), edit-stock
floor constraint, QR scan with slot completion and `remaining_stock` decrement, and
voucher soft delete with active QR guard.

**Requirements:** R7

**Dependencies:** Units 6, 7, 8, 9

**Files:**
- Modify: `tests/integration/routes/admin/vouchers.test.ts`
- Modify: `tests/integration/routes/admin/qr-codes.test.ts`
- Modify: `tests/helpers/fixtures.ts` (add `createActiveFeeSetting`, `createSystemConfig`)

**Approach:**
- Add `createActiveFeeSetting` and `createSystemConfig` fixture helpers (needed as
  pre-conditions for voucher creation tests)
- Voucher creation tests: verify DB state (slot count, QR count, snapshot values)
- Edit-stock tests: verify floor rejection, new slot generation, deleted slot count
- QR scan tests: set QR to `redeemed` status in DB before scan (simulates Phase 2 user
  redeem); verify slot + remainingStock updates

**Test scenarios:** (see §5.3 of origin brainstorm for complete table)

Key scenarios:
- Voucher create → `slotsCreated` and `qrCodesCreated` in response; DB slot + QR count match
- Voucher create no active fee → 422
- Edit stock up 5 → 5 new slots in DB
- Edit stock down to floor → rejected 422
- QR scan (status redeemed) → last QR in slot → slot `fully_used` + `remainingStock - 1`
- QR scan (status available) → 422 `QR_NOT_REDEEMED`
- Voucher soft delete with redeemed QR → 422 `VOUCHER_HAS_ACTIVE_QR`

**Verification:**
- All voucher integration tests pass
- QR scan integration tests pass including slot completion path

---

- [ ] **Unit 19: Integration tests — merchants, settings, role isolation**

**Goal:** Test GET merchant detail, GET merchants/select, settings update with new fields,
and role isolation across all fixed permission gates.

**Requirements:** R5, R6, R7

**Dependencies:** Units 10, 14, 15

**Files:**
- Modify: `tests/integration/routes/admin/merchants.test.ts`
- Modify: `tests/integration/routes/admin/settings.test.ts`

**Approach:**
- Merchant tests: GET /:id with correct access control; soft delete accessible to manager;
  GET /select returns only unassigned merchants
- Settings tests: GET includes `alchemyRpcUrl`; PUT updates new fields; `appFeeUpdatedAt`
  set when fee changes; validation for wallet address and fee rate range
- Role isolation: spot-check each fixed permission (merchant delete as manager, voucher
  delete as admin, fee activate as manager)

**Test scenarios:**

Merchants:
- GET /:id as admin (own merchant) → 200; different merchant → 403
- GET /select → list excludes merchants with assigned active admin
- Soft delete by manager → 200, `deletedAt` in DB
- Soft delete by owner → 403

Settings:
- GET → includes `alchemyRpcUrl`, `coingeckoApiKey`
- PUT `appFeeRate = 5` → `appFeeUpdatedAt` set
- PUT `devWalletAddress` invalid → 400
- PUT `appFeeRate = 51` → 400

**Verification:**
- All merchant tests pass including access control
- Settings tests pass including new fields and validations

---

## System-Wide Impact

- **Interaction graph:** Voucher creation now writes to three tables in one transaction.
  Any middleware or hook that relies on `prisma.voucher.create` completing without
  subsequent steps will behave differently. The manual `POST /admin/qr-codes` endpoint
  should be removed or disabled to prevent bypassing the slot-linked QR creation flow.

- **Error propagation:** `$transaction` failures roll back the entire voucher (no partial
  state). Slot/QR generation errors surface as a 500 with transaction rollback — the
  voucher is not persisted.

- **State lifecycle risks:**
  - `remaining_stock` is a derived value updated by the QR scan transaction. If the QR
    scan transaction partially fails, `remaining_stock` and slot status may desync.
    Use `prisma.$transaction(async (tx) => {...})` interactive transactions to ensure atomicity.
  - Soft delete + existing tests: existing tests that call `prisma.merchant.delete` or
    `prisma.voucher.delete` in `beforeEach` cleanup will break after soft delete is
    introduced. The `beforeEach` cleanup in `setup.integration.ts` uses `deleteMany`
    (hard delete) which is fine for test cleanup — leave that unchanged.

- **API surface parity:** The back-office plan (in `back-office/docs/plans/`) already
  accounts for the first-login response change (403 → 200). These two changes must be
  deployed in sequence: backend fix first, then back-office fix.

- **Integration coverage:** The slot lifecycle (available → redeemed → fully_used) cannot
  be tested purely with unit tests. Integration tests in Unit 18 must seed the database
  with a `redeemed` slot/QR before testing the scan-to-completion path.

- **Unchanged invariants:** Auth middleware guards (`requireAdmin`, `requireOwner`,
  `requireManager`), rate limiting, CORS config, analytics endpoints, upload endpoint,
  webhook endpoint, and all Phase 2 stubs remain untouched.

## Risk Analysis & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Schema migration breaks existing integration tests | High | Medium | Update fixtures in Unit 5 before running Phase 2 tests; run `pnpm tsc --noEmit` after each unit |
| PostgreSQL `ALTER TYPE RENAME VALUE` not supported on DB version | Low | High | Verify Supabase PostgreSQL version (≥ 10 required); fallback: drop + recreate enum with migration |
| `prisma.createMany` returns no individual IDs | Medium | Low | Pre-generate UUIDs in application code before `createMany`; pass as data |
| Partial unique index syntax not expressible in Prisma schema | Medium | Low | Use raw SQL in migration file; document with comment in `schema.prisma` |
| First-login response change breaks back-office before front-end is updated | High | Medium | Coordinate with back-office deployment; back-office already catches 200 `needs_password_setup` in the new plan |
| `$transaction` for large voucher creation (100+ stock) times out | Low | Medium | Prisma `createMany` is batch; default Prisma transaction timeout is 5s — test with stock=100 |

## Phased Delivery

### Phase 1 — Schema Migration (Units 1–5)
Foundation: all DB columns and tables aligned to docs. No route changes. Tests still pass
(fixtures updated). Deployable to staging with schema-only impact.

### Phase 2 — Business Logic Core (Units 6–10)
Core features functional: voucher creation generates slots+QRs, scan works end-to-end,
soft delete everywhere, permissions correct.

### Phase 3 — Endpoint Additions (Units 11–15)
All missing endpoints live: admin filter/pagination, reset-password, change-password,
merchant detail, merchant select dropdown, full settings API.

### Phase 4 — Test Suite (Units 16–19)
Full test coverage for all new and fixed behavior. Regression safety for future changes.

## Documentation / Operational Notes

- After Phase 1 is deployed to staging: run `prisma migrate status` to confirm migration applied
- After Phase 2: test full voucher creation manually — create a voucher and verify
  `SELECT * FROM redemption_slots WHERE voucher_id = '...'` shows correct slot count
- The manual `POST /admin/qr-codes` endpoint (currently in `qr-codes.ts`) should be
  removed in Unit 4 since QR codes are now generated automatically — not in this plan
  but note as cleanup

## Success Criteria (from brainstorm §6)

- [ ] Prisma schema has `redemption_slots` with correct relations and constraints
- [ ] `Admin`, `Merchant`, `Voucher` have `deleted_at`; no hard deletes in routes
- [ ] Voucher creation generates slots + QRs + fee snapshot atomically
- [ ] QR scan: `remaining_stock` decrements when slot becomes `fully_used`
- [ ] `fee-settings activate/delete` accessible to Manager
- [ ] `merchants delete` accessible to Manager (soft delete)
- [ ] `vouchers delete` accessible to Manager + Admin (soft delete)
- [ ] `AppSettings` has correct field names and includes `alchemyRpcUrl`, `coingeckoApiKey`
- [ ] `GET /admin/admins` has pagination and filter
- [ ] `POST /admin/admins/:id/reset-password` exists
- [ ] `GET /admin/merchants/:id` exists
- [ ] `GET /admin/merchants/select` exists
- [ ] `PATCH /auth/change-password` exists
- [ ] First-login → 200 `{ needs_password_setup: true }` not 403
- [ ] All unit tests pass
- [ ] All integration tests pass
- [ ] `pnpm tsc --noEmit` 0 errors
- [ ] Lint 0 errors

## Sources & References

- **Origin document:** [docs/brainstorms/2026-04-14-backend-alignment-brief-brainstorm.md](docs/brainstorms/2026-04-14-backend-alignment-brief-brainstorm.md)
- Brief: `docs/1-project-brief.md` (in project root `/docs/`)
- DB schema: `docs/2-database-schema.md`
- Backend flow: `docs/3-backend-flow.md`
- Comparison: `docs/4-comparison.md`
- Current schema: `prisma/schema.prisma`
- Test infra: `tests/setup.integration.ts`, `tests/helpers/`
