# 05 — Data Layer

## Access Pattern

- **ORM**: Prisma 7.7 with `@prisma/adapter-pg` (direct PostgreSQL, no Supabase JS client)
- **No RLS**: Supabase Row Level Security is bypassed — all auth/scoping enforced at application layer
- **Connection pool**: `pg.Pool` (max 3), proxy-auto-recovered on error (`src/db.ts`)
- **Transactions**: Prisma `$transaction()` used in critical paths (redemption, QR scan, fee activation, voucher stock changes)
- **Row-locking**: `$queryRawUnsafe` with `FOR UPDATE` on voucher row during redemption initiation (`src/services/redemption.ts:52-64`)

---

## Schema — All Tables

### `users`
| Column | Type | Notes |
|--------|------|-------|
| id | TEXT (uuid) | PK |
| email | TEXT | UNIQUE |
| privy_user_id | TEXT | UNIQUE |
| wallet_address | TEXT | nullable |
| created_at / updated_at | TIMESTAMP | auto |

Relations: → Redemption (many), → Transaction (many), → QrCode (many, assignedTo)

### `admins`
| Column | Type | Notes |
|--------|------|-------|
| id | TEXT (uuid) | PK |
| email | TEXT | Partial UNIQUE (where deleted_at IS NULL) |
| password_hash | TEXT | nullable (null = first-login state) |
| role | AdminRole enum | owner / manager / admin |
| merchant_id | TEXT | nullable FK → merchants.id |
| is_active | BOOLEAN | default true |
| created_by | TEXT | nullable self-FK |
| deleted_at | TIMESTAMP | nullable (soft delete) |
| created_at / updated_at | TIMESTAMP | auto |

**Partial unique indices**:
- `admins_email_unique` ON `email` WHERE `deleted_at IS NULL`
- `admins_merchant_unique` ON `merchant_id` WHERE `merchant_id IS NOT NULL AND deleted_at IS NULL`

### `merchants`
| Column | Type | Notes |
|--------|------|-------|
| id | TEXT (uuid) | PK |
| name | TEXT | |
| logo_url | TEXT | nullable |
| description | TEXT | nullable |
| category_id | TEXT | FK → categories.id (RESTRICT) |
| is_active | BOOLEAN | default true |
| created_by | TEXT | nullable FK → admins.id |
| deleted_at | TIMESTAMP | nullable (soft delete) |
| created_at / updated_at | TIMESTAMP | auto |

### `vouchers`
| Column | Type | Notes |
|--------|------|-------|
| id | TEXT (uuid) | PK |
| merchant_id | TEXT | FK → merchants.id (RESTRICT) |
| title | TEXT | |
| description | TEXT | nullable |
| start_date | DATE | |
| expiry_date | DATE | |
| total_stock | INTEGER | |
| remaining_stock | INTEGER | ⚠️ Double-decremented (see pain points) |
| base_price | DECIMAL(15,2) | IDR |
| app_fee_rate | DECIMAL(5,2) | % snapshot at creation |
| gas_fee_amount | DECIMAL(15,2) | IDR snapshot at creation |
| total_price | DECIMAL(15,2) | Computed: base + fee + gas |
| qr_per_slot | INTEGER | default 1, max 2 |
| is_active | BOOLEAN | default true |
| created_by | TEXT | nullable FK → admins.id |
| deleted_at | TIMESTAMP | nullable (soft delete) |
| created_at / updated_at | TIMESTAMP | auto |

### `redemption_slots`
| Column | Type | Notes |
|--------|------|-------|
| id | TEXT (uuid) | PK |
| voucher_id | TEXT | FK → vouchers.id (RESTRICT) |
| slot_index | INTEGER | sequential, 1-based |
| status | SlotStatus | available / redeemed / fully_used |
| redeemed_at | TIMESTAMP | nullable |
| created_at / updated_at | TIMESTAMP | auto |

**Unique**: `(voucher_id, slot_index)` | **Index**: `(voucher_id, status)`

### `qr_codes`
| Column | Type | Notes |
|--------|------|-------|
| id | TEXT (uuid) | PK |
| voucher_id | TEXT | FK → vouchers.id |
| slot_id | TEXT | FK → redemption_slots.id |
| qr_number | SMALLINT | 1 or 2 within slot |
| redemption_id | TEXT | nullable FK → redemptions.id |
| image_url | TEXT | R2 key (e.g., `qr-codes/{redemptionId}/{n}.png`) or placeholder |
| image_hash | TEXT | UNIQUE, SHA-256 of PNG buffer |
| token | TEXT | UNIQUE nullable, 32-char hex random (legacy scan compat) |
| status | QrStatus | available / redeemed / used |
| assigned_to_user_id | TEXT | nullable FK → users.id |
| assigned_at / redeemed_at / used_at | TIMESTAMP | nullable lifecycle timestamps |
| scanned_by_admin_id | TEXT | nullable FK → admins.id |
| created_at / updated_at | TIMESTAMP | auto |

**Comment in schema**: `// TODO: deprecate after Phase 2 - kept for current scan endpoint compatibility` (imageUrl column note)

### `redemptions`
| Column | Type | Notes |
|--------|------|-------|
| id | TEXT (uuid) | PK |
| user_id | TEXT | FK → users.id (RESTRICT) |
| voucher_id | TEXT | FK → vouchers.id (RESTRICT) |
| wealth_amount | DECIMAL(36,18) | total WEALTH tokens required |
| price_idr_at_redeem | INTEGER | base price IDR at time of redeem |
| wealth_price_idr_at_redeem | DECIMAL(18,4) | WEALTH/IDR rate at time of redeem |
| app_fee_amount | DECIMAL(36,18) | app fee in WEALTH |
| gas_fee_amount | DECIMAL(36,18) | gas fee in WEALTH (default 0) |
| tx_hash | TEXT | UNIQUE nullable — filled after user submits |
| idempotency_key | TEXT | UNIQUE (uuid, per-user+voucher) |
| status | RedemptionStatus | pending / confirmed / failed |
| redeemed_at | TIMESTAMP | default now() |
| confirmed_at | TIMESTAMP | nullable |
| created_at | TIMESTAMP | auto |

### `transactions`
| Column | Type | Notes |
|--------|------|-------|
| id | TEXT (uuid) | PK |
| user_id | TEXT | FK → users.id |
| redemption_id | TEXT | UNIQUE nullable FK → redemptions.id |
| type | TransactionType | deposit / withdrawal / redeem |
| amount_wealth | DECIMAL(36,18) | |
| tx_hash | TEXT | UNIQUE nullable |
| status | TransactionStatus | pending / confirmed / failed |
| created_at / confirmed_at | TIMESTAMP | auto / nullable |

### `app_settings`
| Column | Type | Notes |
|--------|------|-------|
| id | TEXT | PK, always "singleton" |
| app_fee_rate | DECIMAL(5,2) | default 3.00% |
| wealth_contract_address | TEXT | nullable |
| dev_wallet_address | TEXT | nullable (treasury) |
| alchemy_rpc_url | TEXT | nullable (override from DB) |
| coingecko_api_key | TEXT | ⚠️ stored but NOT used by price service |
| app_fee_updated_by | TEXT | nullable FK → admins.id |
| app_fee_updated_at | TIMESTAMP | nullable |
| updated_at | TIMESTAMP | auto |

### `fee_settings`
| Column | Type | Notes |
|--------|------|-------|
| id | TEXT (uuid) | PK |
| label | TEXT | display name |
| amount_idr | DECIMAL(15,2) | gas fee amount in IDR |
| is_active | BOOLEAN | exactly one active at a time |
| created_at / updated_at | TIMESTAMP | auto |

### `categories`
| Column | Type | Notes |
|--------|------|-------|
| id | TEXT (uuid) | PK |
| name | TEXT | UNIQUE |
| is_active | BOOLEAN | default true |
| created_at / updated_at | TIMESTAMP | auto |

Default values: kuliner, hiburan, event, kesehatan, lifestyle, travel

---

## Migration History

| File | Date | Changes |
|------|------|---------|
| `20260409230024_init` | Apr 9 | Initial schema — old design (MerchantCategory enum, price_idr as INT, dev_cut_amount) |
| `20260412120000_multi_qr_pricing_fees` | Apr 12 | Multi-QR support, fee_settings table, 3-component pricing, passwordHash nullable |
| `20260413000000_admin_roles_qr_system` | Apr 13 | Add `manager` to AdminRole enum (split into 2 migrations due to Postgres enum commit requirement) |
| `20260413000001_admin_roles_qr_schema` | Apr 13 | Add merchant_id to admins, add token + scanned_by_admin_id to qr_codes |
| `20260414173147_schema_alignment_phase_1` | Apr 14 | Soft-delete on admins/merchants/vouchers, redemption_slots table, fee snapshot on vouchers, rename columns, add QR slot_id, add categories support in app_settings |
| `20260424000000_email_partial_unique_soft_delete` | Apr 24 | Drop absolute unique on admins.email → partial unique (where deleted_at IS NULL) |

### 🚩 MISSING MIGRATION — Categories Table

The `categories` table and `merchants.category_id` FK exist in `prisma/schema.prisma` but **no migration creates them**. The migration history shows:
- `init`: creates `merchants.category` (MerchantCategory enum — old design)
- `20260414`: adds `merchants.deleted_at` only — does NOT drop `category` enum or add `category_id`

**Probable cause**: Table was created out-of-band (via `prisma db push` or manual SQL) and a migration was never generated. Running `prisma migrate deploy` on a fresh DB would fail or produce an inconsistent state.

---

## Source of Truth Per Entity

| Entity | Source |
|--------|--------|
| WEALTH price in USD | CoinMarketCap API (cached 60s) |
| USD/IDR rate | open.er-api.com (cached 15min) |
| On-chain tx status | Alchemy webhook OR viem RPC on-demand |
| Admin roles/permissions | PostgreSQL (DB checked on every request) |
| Voucher stock | `remainingStock` column (⚠️ potentially inaccurate due to double-decrement) |
| QR code status | DB (`qr_codes.status`) |
| Treasury wallet | `app_settings.dev_wallet_address` (not env var at runtime) |

---

## Prisma Seed Issue

After migration `20260424`, `admins.email` has only a **partial** unique index. But `prisma/seed.ts:38,68,83` uses:

```javascript
prisma.admin.upsert({ where: { email: ownerEmail }, ... })
```

Prisma requires the `where` field in `upsert` to reference a `@unique` or `@@unique` constraint defined in `schema.prisma`. Since `email` is no longer `@unique` (only a DB-level partial index exists), this `upsert` call will fail with a Prisma validation error.

**The seed is broken after the latest migration.**
