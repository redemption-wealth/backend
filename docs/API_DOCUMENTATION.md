# WEALTH Redemption Backend - API Documentation

**Version:** 2.0.0
**Base URL:** `https://your-api-domain.com/api`
**Last Updated:** 2026-04-14

---

## Table of Contents

1. [Authentication](#authentication)
2. [Public Routes (App)](#public-routes-app)
   - [Auth](#-auth)
   - [Merchants](#-merchants)
   - [Vouchers](#-vouchers)
   - [Redemptions](#-redemptions)
   - [Transactions](#-transactions)
   - [Price](#-price)
   - [Categories](#️-categories)
3. [Admin Routes (Back-office)](#admin-routes-back-office)
4. [Common Patterns](#common-patterns)
5. [Error Responses](#error-responses)
6. [Data Models](#data-models)

---

## Authentication

### Admin Authentication (JWT)

All admin routes require a JWT token in the `Authorization` header:

```
Authorization: Bearer <jwt_token>
```

**Obtain Token:**
- POST `/api/auth/login` - Login with email/password
- Returns: `{ token: string, admin: AdminObject }`

**Token Claims:**
- `id` - Admin ID
- `email` - Admin email
- `role` - "owner" | "manager" | "admin"
- `merchantId` - (admin role only) linked merchant UUID
- Expires in 24 hours

### User Authentication (Privy)

All user routes require a Privy authentication token:

```
Authorization: Bearer <privy_token>
```

Users must first sync via POST `/api/auth/user-sync` after Privy login.

---

## Public Routes (App)

### 🔐 Auth

#### `POST /api/auth/user-sync`
Sync user from Privy to database.

**Headers:**
```
Authorization: Bearer <privy_token>
```

**Response:** `200 OK`
```json
{
  "user": {
    "id": "uuid",
    "email": "user@example.com",
    "privyUserId": "privy-id",
    "walletAddress": "0x...",
    "createdAt": "2026-01-01T00:00:00Z"
  }
}
```

---

### 🏪 Merchants

#### `GET /api/merchants`
List active merchants.

**Query Parameters:**
- `categoryId` (optional) - Filter by category ID (UUID)
- `search` (optional) - Search by name (case-insensitive)
- `page` (optional, default: 1) - Page number
- `limit` (optional, default: 20, max: 100) - Items per page

**Response:** `200 OK`
```json
{
  "merchants": [
    {
      "id": "uuid",
      "name": "Merchant Name",
      "categoryId": "uuid",
      "category": {
        "name": "kuliner"
      },
      "logoUrl": "https://...",
      "description": "...",
      "isActive": true,
      "createdAt": "2026-01-01T00:00:00Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 50,
    "totalPages": 3
  }
}
```

#### `GET /api/merchants/:id`
Get merchant details with active vouchers.

**Response:** `200 OK`
```json
{
  "merchant": {
    "id": "uuid",
    "name": "Merchant Name",
    "category": "kuliner",
    "logoUrl": "https://...",
    "description": "...",
    "isActive": true,
    "vouchers": [
      {
        "id": "uuid",
        "title": "Voucher Title",
        "priceIdr": 25000,
        "remainingStock": 10,
        "startDate": "2026-01-01T00:00:00Z",
        "endDate": "2026-12-31T00:00:00Z"
      }
    ]
  }
}
```

---

### 🎫 Vouchers

#### `GET /api/vouchers`
List active, in-stock, non-expired vouchers.

**Query Parameters:**
- `merchantId` (optional) - Filter by merchant
- `category` (optional) - Filter by merchant category
- `search` (optional) - Search by title
- `page` (optional, default: 1)
- `limit` (optional, default: 20, max: 100)

**Response:** `200 OK`
```json
{
  "vouchers": [
    {
      "id": "uuid",
      "merchantId": "uuid",
      "title": "Voucher Title",
      "priceIdr": 25000,
      "qrPerRedemption": 1,
      "availableStock": 48,
      "assignedStock": 2,
      "usedStock": 50,
      "totalStock": 100,
      "remainingStock": 50,
      "isAvailable": true,
      "startDate": "2026-01-01T00:00:00Z",
      "endDate": "2026-12-31T00:00:00Z",
      "isActive": true,
      "merchant": {
        "name": "Merchant Name",
        "category": "kuliner"
      }
    }
  ],
  "pagination": { ... }
}
```

**Stock Fields:**
- `availableStock` - Vouchers ready to redeem (QR codes with status='available')
- `assignedStock` - Vouchers pending confirmation (QR codes with status='assigned')
- `usedStock` - Completed redemptions (incremented on blockchain confirmation)
- `totalStock` - Total vouchers created
- `isAvailable` - True if availableStock > 0

#### `GET /api/vouchers/:id`
Get voucher details.

**Response:** `200 OK`
```json
{
  "voucher": {
    "id": "uuid",
    "title": "Voucher Title",
    "priceIdr": 25000,
    "qrPerRedemption": 1,
    "remainingStock": 50,
    "merchant": { ... }
  }
}
```

#### `POST /api/vouchers/:id/redeem`
Initiate voucher redemption. **Requires user auth.**

**Headers:**
```
Authorization: Bearer <privy_token>
```

**Body:**
```json
{
  "idempotencyKey": "uuid-v4",
  "wealthPriceIdr": 850.5
}
```

**Response:** `200 OK`
```json
{
  "redemption": {
    "id": "uuid",
    "userId": "uuid",
    "voucherId": "uuid",
    "wealthAmount": "100.588",
    "priceIdrAtRedeem": 25000,
    "wealthPriceIdrAtRedeem": "850.5",
    "appFeeAmount": "0.882",
    "gasFeeAmount": "5.882",
    "status": "pending",
    "qrCodes": [
      {
        "id": "uuid",
        "imageUrl": "https://...",
        "status": "assigned"
      }
    ]
  },
  "alreadyExists": false
}
```

**Important:**
- `idempotencyKey` must be a unique UUID v4 per redemption attempt
- `wealthPriceIdr` is the current $WEALTH price in IDR (get from `/api/price/wealth`)
- Server validates price within 5% tolerance
- Returns existing redemption if `idempotencyKey` was already used

---

### 💰 Redemptions

#### `GET /api/redemptions`
List user's redemptions. **Requires user auth.**

**Query Parameters:**
- `status` (optional) - Filter: "pending" | "confirmed" | "failed"
- `page`, `limit` - Pagination

**Response:** `200 OK`
```json
{
  "redemptions": [
    {
      "id": "uuid",
      "status": "confirmed",
      "wealthAmount": "100.588",
      "txHash": "0x...",
      "confirmedAt": "2026-01-01T12:00:00Z",
      "voucher": {
        "title": "Voucher Title",
        "merchant": { "name": "Merchant" }
      },
      "qrCodes": [ ... ]
    }
  ],
  "pagination": { ... }
}
```

#### `GET /api/redemptions/:id`
Get redemption details. **Requires user auth.**

**Response:** `200 OK`
```json
{
  "redemption": {
    "id": "uuid",
    "status": "confirmed",
    "wealthAmount": "100.588",
    "priceIdrAtRedeem": 25000,
    "appFeeAmount": "0.882",
    "gasFeeAmount": "5.882",
    "txHash": "0x...",
    "voucher": { ... },
    "qrCodes": [ ... ],
    "transaction": {
      "id": "uuid",
      "amountWealth": "100.588",
      "status": "confirmed"
    }
  }
}
```

#### `PATCH /api/redemptions/:id/submit-tx`
Submit blockchain transaction hash. **Requires user auth.**

**Body:**
```json
{
  "txHash": "0x1234..." // 0x + 64 hex chars
}
```

**Response:** `200 OK`
```json
{
  "redemption": {
    "id": "uuid",
    "txHash": "0x1234...",
    "status": "pending"
  }
}
```

**Errors:**
- `400` - Invalid txHash format, already used, or redemption not pending
- `404` - Redemption not found or doesn't belong to user

---

### 💳 Transactions

#### `GET /api/transactions`
List user's transactions. **Requires user auth.**

**Query Parameters:**
- `type` (optional) - Filter: "redeem" | "refund"
- `page`, `limit` - Pagination

**Response:** `200 OK`
```json
{
  "transactions": [
    {
      "id": "uuid",
      "type": "redeem",
      "amountWealth": "100.588",
      "txHash": "0x...",
      "status": "confirmed",
      "confirmedAt": "2026-01-01T12:00:00Z",
      "createdAt": "2026-01-01T11:50:00Z"
    }
  ],
  "pagination": { ... }
}
```

---

### 💹 Price

#### `GET /api/price/wealth`
Get current $WEALTH price in IDR from CoinGecko.

**Response:** `200 OK`
```json
{
  "priceIdr": 850.5,
  "cached": false,
  "stale": false
}
```

**Notes:**
- Cached for 60 seconds
- Returns stale cache if CoinGecko fails
- `stale: true` means cached data used because API failed

---

### 🏷️ Categories

#### `GET /api/categories`
Get all active merchant categories.

**Response:** `200 OK`
```json
{
  "data": [
    {
      "id": "uuid",
      "name": "kuliner"
    },
    {
      "id": "uuid",
      "name": "hiburan"
    },
    {
      "id": "uuid",
      "name": "travel"
    }
  ]
}
```

**Notes:**
- Returns only active categories
- Categories are sorted by name (ascending)
- Simplified structure - only id and name fields
- Use categoryId for filtering merchants

#### `GET /api/categories/:id`
Get a specific category by ID.

**Response:** `200 OK`
```json
{
  "data": {
    "id": "uuid",
    "name": "kuliner",
    "isActive": true
  }
}
```

**Errors:**
- `404` - Category not found

---

## Admin Routes (Back-office)

All admin routes require JWT authentication via `Authorization: Bearer <token>`.

### Role Permission Matrix

| Capability | owner | manager | admin |
|---|:---:|:---:|:---:|
| Manage admin accounts | ✓ | — | — |
| App / fee settings (write) | ✓ | ✓ | — |
| Merchants (create/edit) | ✓ | ✓ | — |
| Merchants (delete) | ✓ | — | — |
| Vouchers (create/edit) | ✓ | ✓ | ✓ (own merchant) |
| QR management (list) | ✓ | ✓ | ✓ (own merchant) |
| Scan QR | ✓ (any) | ✓ (any) | ✓ (own merchant) |
| Analytics | ✓ (all) | ✓ (all) | ✓ (own merchant) |
| Redemptions (view) | ✓ (all) | ✓ (all) | ✓ (own merchant) |
| App settings (read) | ✓ | — | — |

> **Note:** Every authenticated request re-validates the admin record from the database. Deactivating an admin account immediately invalidates their existing JWT tokens.

### 🔐 Admin Auth

#### `POST /api/auth/login`
Admin login.

**Body:**
```json
{
  "email": "admin@example.com",
  "password": "password123"
}
```

**Response:** `200 OK`
```json
{
  "token": "jwt-token-string",
  "admin": {
    "id": "uuid",
    "email": "admin@example.com",
    "role": "owner | manager | admin",
    "merchantId": "uuid or null",
    "isActive": true
  }
}
```

**Errors:**
- `401` - Invalid credentials (wrong password or email not found)
- `401` - Account is inactive
- `403` - Password not set (first-login flow required)
  ```json
  {
    "error": "Password belum diset",
    "code": "PASSWORD_NOT_SET"
  }
  ```

**First-Login Flow:**
When admin receives `PASSWORD_NOT_SET` error, redirect to set-password page.
Use `POST /api/auth/set-password` to complete first-login setup.

**Errors:**
- `401` - Invalid credentials or inactive admin
- `400` - Validation error

#### `POST /api/auth/set-password`
Set password for first-time login (admin with null password).

**Body:**
```json
{
  "email": "admin@example.com",
  "password": "newpassword123",
  "confirmPassword": "newpassword123"
}
```

**Response:** `200 OK`

**Errors:**
- `401` - Admin not found
- `409` - Admin already has password
- `400` - Passwords don't match or too short

#### `GET /api/auth/me`
Get current admin info. **Requires admin auth.**

**Response:** `200 OK`
```json
{
  "admin": {
    "id": "uuid",
    "email": "admin@example.com",
    "role": "owner"
  }
}
```

---

### 🏪 Admin - Merchants

#### `GET /api/admin/merchants`
List all merchants (including inactive). **Requires admin auth.**

**Query Parameters:**
- `category`, `search`, `page`, `limit` - Same as public route

**Response:** `200 OK` - Same structure as public route

#### `POST /api/admin/merchants`
Create merchant. **Requires admin auth.**

**Body:**
```json
{
  "name": "Merchant Name",
  "category": "kuliner",
  "logoUrl": "https://...", // optional
  "description": "..." // optional
}
```

**Response:** `201 Created`
```json
{
  "merchant": {
    "id": "uuid",
    "name": "Merchant Name",
    "category": "kuliner",
    "isActive": true,
    "createdBy": "admin-uuid"
  }
}
```

#### `PUT /api/admin/merchants/:id`
Update merchant. **Requires admin auth.**

**Body:** (all fields optional)
```json
{
  "name": "Updated Name",
  "category": "fashion",
  "logoUrl": "https://...",
  "description": "...",
  "isActive": false
}
```

**Response:** `200 OK`

#### `DELETE /api/admin/merchants/:id`
Delete merchant. **Requires owner auth.**

**Response:** `200 OK`

**Errors:**
- `403` - Not owner
- `400` - Merchant has vouchers (FK constraint)

---

### 🎫 Admin - Vouchers

#### `GET /api/admin/vouchers`
List all vouchers. **Requires admin auth.**

**Query Parameters:**
- `merchantId`, `search`, `page`, `limit`

**Response:** `200 OK`

#### `POST /api/admin/vouchers`
Create voucher. **Requires admin auth.**

**Body:**
```json
{
  "merchantId": "uuid",
  "title": "Voucher Title",
  "startDate": "2026-01-01T00:00:00Z",
  "endDate": "2026-12-31T23:59:59Z",
  "totalStock": 100,
  "priceIdr": 25000,
  "qrPerRedemption": 1 // 1 or 2
}
```

**Response:** `201 Created`
```json
{
  "voucher": {
    "id": "uuid",
    "title": "Voucher Title",
    "remainingStock": 100,
    "totalStock": 100,
    "qrPerRedemption": 1
  },
  "qrCodesGenerated": 100
}
```

**Note:** QR tokens are pre-generated with status='available'. Images are generated lazily when users redeem.

**Validation:**
- `priceIdr` >= 1000
- `totalStock` > 0
- `endDate` > `startDate`
- `qrPerRedemption` must be 1 or 2

#### `PUT /api/admin/vouchers/:id`
Update voucher. **Requires admin auth.**

**Body:** (all optional except `qrPerRedemption` is immutable)
```json
{
  "title": "Updated Title",
  "priceIdr": 30000,
  "isActive": false
}
```

**Response:** `200 OK`

**Note:** Cannot change `qrPerRedemption` or `remainingStock` directly.

#### `DELETE /api/admin/vouchers/:id`
Delete voucher. **Requires owner auth.**

**Errors:**
- `400` - Voucher has redemptions

---

### 🎨 Admin - QR Codes

#### `GET /api/admin/qr-codes`
List QR codes. **Requires admin auth.** Admin role sees only their merchant's QR codes.

**Query Parameters:**
- `voucherId` (optional) - Filter by voucher
- `status` (optional) - Filter: "available" | "assigned" | "used"
- `page`, `limit`

**Response:** `200 OK`
```json
{
  "qrCodes": [
    {
      "id": "uuid",
      "voucherId": "uuid",
      "imageUrl": "https://...",
      "imageHash": "hash",
      "status": "available",
      "assignedToUserId": null,
      "assignedAt": null,
      "usedAt": null,
      "voucher": {
        "title": "Voucher Title"
      }
    }
  ],
  "pagination": { ... }
}
```

#### `POST /api/admin/qr-codes`
Create QR code. **Requires admin auth.**

**Body:**
```json
{
  "voucherId": "uuid",
  "imageUrl": "https://...",
  "imageHash": "unique-hash"
}
```

**Response:** `201 Created`

**Errors:**
- `400` - Duplicate `imageHash` or invalid `voucherId`

#### `POST /api/admin/qr-codes/scan`
Scan a QR token to validate and mark as used. **Requires admin auth.** Rate limited to 60 requests/minute per admin.

**Body:**
```json
{
  "token": "32-char-hex-string"
}
```

**Response:** `200 OK`
```json
{
  "success": true,
  "voucherId": "uuid",
  "usedAt": "2026-01-01T12:00:00Z",
  "scannedByAdminId": "uuid"
}
```

**Errors:**
- `404` - `{ "error": "NOT_FOUND" }` — token not in DB
- `403` - `{ "error": "WRONG_MERCHANT" }` — admin role scanning QR for different merchant
- `409` - `{ "error": "ALREADY_USED" }` — QR already scanned
- `422` - QR not in assignable state
- `429` - Rate limit exceeded

> **Removed:** `POST /api/admin/qr-codes/:id/mark-used` has been removed. Use `/scan` instead.

---

### 💰 Admin - Redemptions

#### `GET /api/admin/redemptions`
List all redemptions. **Requires admin auth.**

**Query Parameters:**
- `status` (optional) - Filter by status
- `page`, `limit`

**Response:** `200 OK`
```json
{
  "redemptions": [
    {
      "id": "uuid",
      "status": "confirmed",
      "wealthAmount": "100.588",
      "txHash": "0x...",
      "user": {
        "email": "user@example.com"
      },
      "voucher": {
        "title": "Voucher Title",
        "merchant": { "name": "Merchant" }
      },
      "qrCodes": [ ... ]
    }
  ],
  "pagination": { ... }
}
```

#### `GET /api/admin/redemptions/:id`
Get redemption details. **Requires admin auth.**

**Response:** `200 OK` - Full redemption object with relations

---

### ⚙️ Admin - Settings

#### `GET /api/admin/settings`
Get app settings. **Requires admin auth.**

**Response:** `200 OK`
```json
{
  "settings": {
    "id": "singleton",
    "appFeePercentage": "3.0",
    "tokenContractAddress": "0x...",
    "treasuryWalletAddress": "0x..."
  }
}
```

#### `PUT /api/admin/settings`
Update app settings. **Requires owner auth.**

**Body:** (all optional)
```json
{
  "appFeePercentage": 3.5,
  "tokenContractAddress": "0x...",
  "treasuryWalletAddress": "0x..."
}
```

**Response:** `200 OK`

**Validation:**
- `appFeePercentage`: 0-100

---

### 💸 Admin - Fee Settings

#### `GET /api/admin/fee-settings`
List all gas fee settings. **Requires admin auth.**

**Response:** `200 OK`
```json
{
  "feeSettings": [
    {
      "id": "uuid",
      "label": "Standard Gas Fee",
      "amountIdr": 5000,
      "isActive": true,
      "createdAt": "2026-01-01T00:00:00Z"
    }
  ]
}
```

#### `POST /api/admin/fee-settings`
Create fee setting. **Requires admin auth.**

**Body:**
```json
{
  "label": "Premium Gas Fee",
  "amountIdr": 10000
}
```

**Response:** `201 Created`

#### `PUT /api/admin/fee-settings/:id`
Update fee setting. **Requires admin auth.**

**Body:**
```json
{
  "label": "Updated Label",
  "amountIdr": 7000
}
```

**Response:** `200 OK`

#### `POST /api/admin/fee-settings/:id/activate`
Set fee as active (deactivates all others). **Requires owner auth.**

**Response:** `200 OK`

#### `DELETE /api/admin/fee-settings/:id`
Delete fee setting. **Requires owner auth.**

**Errors:**
- `400` - Cannot delete active fee

---

### 👥 Admin - User Management

#### `GET /api/admin/admins`
List all admins. **Requires owner auth.**

**Response:** `200 OK`
```json
{
  "admins": [
    {
      "id": "uuid",
      "email": "admin@example.com",
      "role": "owner | manager | admin",
      "merchantId": "uuid or null",
      "isActive": true,
      "createdAt": "2026-01-01T00:00:00Z",
      "assignedMerchant": { "id": "uuid", "name": "Merchant Name" }
    }
  ]
}
```

#### `POST /api/admin/admins`
Create admin. **Requires owner auth.**

**Body:**
```json
{
  "email": "newadmin@example.com",
  "password": "password123",
  "role": "owner | manager | admin",
  "merchantId": "uuid"
}
```

> - `role` defaults to `"manager"`.
> - `merchantId` is **required** when `role` is `"admin"`, **forbidden** for `"owner"` and `"manager"`.
> - Returns `404` if `merchantId` does not exist.

**Response:** `201 Created`

**Errors:**
- `400` - Validation failed (missing merchantId for admin, or merchantId provided for non-admin)
- `404` - Merchant not found
- `403` - Not owner

#### `PUT /api/admin/admins/:id`
Update admin. **Requires owner auth.**

**Body:**
```json
{
  "isActive": false,
  "merchantId": "uuid or null"
}
```

> - `merchantId` can only be updated on `admin`-role accounts. Returns `400` if target is owner/manager.
> - Set `merchantId: null` to unlink admin from their merchant.

**Response:** `200 OK`

**Errors:**
- `400` - merchantId update attempted on non-admin role
- `404` - Admin or merchant not found
- `403` - Not owner

#### `DELETE /api/admin/admins/:id`
Delete admin. **Requires owner auth.**

**Errors:**
- `400` - Cannot delete self
- `400` - Cannot delete last owner

---

### 📊 Admin - Analytics

#### `GET /api/admin/analytics/summary`
Get dashboard summary stats. **Requires admin or owner auth.**

**Response:** `200 OK`
```json
{
  "summary": {
    "totalMerchants": 25,
    "totalVouchers": 150,
    "totalRedemptions": 500,
    "confirmedRedemptions": 480,
    "totalWealthVolume": "50000.123",
    "totalUsers": 120,
    "avgWealthPerRedeem": "104.167",
    "totalValueIdr": 12500000
  }
}
```

#### `GET /api/admin/analytics/recent-activity`
Get recent redemptions. **Requires admin or owner auth.**

**Query Parameters:**
- `limit` (optional, default: 10, max: 50)

**Response:** `200 OK`
```json
{
  "activities": [
    {
      "id": "uuid",
      "status": "confirmed",
      "wealthAmount": "100.588",
      "confirmedAt": "2026-01-01T12:00:00Z",
      "user": { "email": "user@example.com" },
      "voucher": {
        "title": "Voucher Title",
        "merchant": { "name": "Merchant" }
      }
    }
  ]
}
```

#### `GET /api/admin/analytics/redemptions-over-time`
Get redemption trends over time. **Requires admin or owner auth.**

**Query Parameters:**
- `period` (optional, default: "daily") - "daily" | "yearly" | "monthly"

**Response:** `200 OK`
```json
{
  "data": [
    {
      "period": "2026-01-01",
      "count": 15
    },
    {
      "period": "2026-01-02",
      "count": 23
    }
  ]
}
```

#### `GET /api/admin/analytics/merchant-categories`
Get merchant distribution by category. **Requires admin or owner auth.**

**Response:** `200 OK`
```json
{
  "data": [
    {
      "categoryName": "kuliner",
      "count": 12
    },
    {
      "categoryName": "hiburan",
      "count": 8
    }
  ]
}
```

#### `GET /api/admin/analytics/wealth-volume`
Get WEALTH token volume over time. **Requires admin or owner auth.**

**Query Parameters:**
- `period` (optional, default: "monthly") - "daily" | "yearly" | "monthly"

**Response:** `200 OK`
```json
{
  "data": [
    {
      "period": "2026-01",
      "volume": "5000.123"
    },
    {
      "period": "2026-02",
      "volume": "7500.456"
    }
  ]
}
```

#### `GET /api/admin/analytics/top-merchants`
Get top performing merchants by redemption count. **Requires admin or owner auth.**

**Query Parameters:**
- `limit` (optional, default: 3, max: 10)

**Response:** `200 OK`
```json
{
  "data": [
    {
      "id": "uuid",
      "name": "Merchant A",
      "logoUrl": "https://...",
      "redeemCount": 150,
      "wealthVolume": "15000.50"
    },
    {
      "id": "uuid",
      "name": "Merchant B",
      "logoUrl": "https://...",
      "redeemCount": 120,
      "wealthVolume": "12000.30"
    }
  ]
}
```

#### `GET /api/admin/analytics/top-vouchers`
Get top performing vouchers by redemption count. **Requires admin or owner auth.**

**Query Parameters:**
- `limit` (optional, default: 3, max: 10)

**Response:** `200 OK`
```json
{
  "data": [
    {
      "id": "uuid",
      "title": "Discount 50%",
      "merchantName": "Merchant A",
      "redeemCount": 85,
      "wealthVolume": "8500.75"
    }
  ]
}
```

#### `GET /api/admin/analytics/treasury-balance`
Get treasury wallet balance (stub for blockchain integration). **Requires owner auth.**

**Response:** `200 OK`
```json
{
  "balance": "0",
  "tokenAddress": "0x...",
  "treasuryAddress": "0x...",
  "note": "Blockchain integration pending. Balance is currently a placeholder."
}
```

**Errors:**
- `400` - Treasury addresses not configured in settings

**Notes:**
- All analytics endpoints use 5-minute cache
- Admin role receives merchant-scoped data automatically (no query param needed)
- Owner/manager receive platform-wide data

---

### 📤 Admin - File Upload

#### `POST /api/admin/upload/logo`
Upload merchant logo to R2 storage. **Requires manager or owner auth.**

**Content-Type:** `multipart/form-data`

**Body:**
- `file` - Image file (max 5MB, images only: jpg, png, gif, webp)

**Response:** `201 Created`
```json
{
  "url": "https://pub-xxx.r2.dev/logos/uuid.png",
  "filename": "uuid.png",
  "size": 123456,
  "contentType": "image/png"
}
```

**Errors:**
- `400` - No file provided
- `400` - File too large (max 5MB)
- `400` - Invalid file type (only images allowed)
- `500` - Upload failed

**Notes:**
- Files are stored in public R2 bucket
- Returns public URL immediately accessible
- UUID filename prevents collisions

> **Removed:** `POST /api/admin/vouchers/:id/upload-qr` has been removed. QR codes are now auto-generated at redemption time — no manual ZIP upload needed.

---

## Common Patterns

### Pagination

All list endpoints support pagination:

**Query Parameters:**
- `page` (default: 1) - Page number (1-indexed)
- `limit` (default: 20, max: 100) - Items per page

**Response:**
```json
{
  "items": [ ... ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 150,
    "totalPages": 8
  }
}
```

### Filtering & Search

- **Category filters:** Use exact enum values
- **Search:** Case-insensitive, partial match on names/titles
- **Status filters:** Use exact enum values

### Idempotency

Redemption creation uses `idempotencyKey` to prevent duplicate redemptions:
- Key must be UUID v4
- Scoped to user
- Returns existing redemption with `alreadyExists: true`

---

## Error Responses

### Standard Error Format

```json
{
  "error": "Error message",
  "details": { ... } // optional, for validation errors
}
```

### HTTP Status Codes

| Code | Meaning |
|------|---------|
| `200` | Success |
| `201` | Created |
| `400` | Bad Request (validation error) |
| `401` | Unauthorized (missing/invalid token) |
| `403` | Forbidden (insufficient permissions) |
| `404` | Not Found |
| `409` | Conflict (duplicate, constraint violation) |
| `429` | Too Many Requests (rate limited) |
| `500` | Internal Server Error |

### Validation Errors

```json
{
  "error": "Validation failed",
  "details": {
    "fieldErrors": {
      "email": ["Invalid email format"],
      "password": ["Must be at least 8 characters"]
    }
  }
}
```

---

## Data Models

### Enums

**AdminRole:**
- `"owner"` - Full platform access including admin management and settings
- `"manager"` - Platform-level access (merchants, vouchers, analytics, fee settings). Cannot manage admin accounts.
- `"admin"` - Merchant-scoped access. Must be linked to a specific merchant. Can only see/manage that merchant's vouchers, QR codes, redemptions, and analytics.

**MerchantCategory:**
- `"kuliner"`
- `"hiburan"`
- `"event"`
- `"kesehatan"`
- `"lifestyle"`
- `"travel"`

**Note:** Categories are also available via the `/api/categories` endpoint for dynamic fetching with display names, descriptions, and icons.

**QrStatus:**
- `"available"` - Ready for redemption
- `"assigned"` - Assigned to user via redemption
- `"used"` - Marked as used by merchant

**RedemptionStatus:**
- `"pending"` - Waiting for blockchain confirmation
- `"confirmed"` - Blockchain tx confirmed
- `"failed"` - Blockchain tx failed

**TransactionType:**
- `"redeem"` - Redemption transaction
- `"refund"` - Refund transaction

**TransactionStatus:**
- `"pending"`
- `"confirmed"`
- `"failed"`

### Field Constraints

**Email:** Valid email format
**Password:** 8-128 characters
**Price IDR:** >= 1000
**App Fee %:** 0-100
**Stock:** > 0
**qrPerRedemption:** 1 or 2
**txHash:** `0x` + 64 hex characters

---

## Rate Limiting

The following endpoints are rate-limited:

| Endpoint | Limit |
|----------|-------|
| `POST /api/auth/login` | 5 attempts per email per 15 min |
| `POST /api/auth/set-password` | 3 attempts per email per 15 min |
| `POST /api/auth/user-sync` | 10 requests per IP per minute |

**Response:** `429 Too Many Requests`
```json
{
  "error": "Too many requests",
  "retryAfter": 900
}
```

---

## Webhooks

### Alchemy Webhook (Internal)

**Endpoint:** `POST /api/webhook/alchemy`

**Headers:**
```
x-alchemy-signature: <signature>
Content-Type: application/json
```

**Body:**
```json
{
  "event": {
    "activity": [
      {
        "hash": "0x...",
        "category": "token",
        "typeTraceAddress": "CALL"
      }
    ]
  }
}
```

**Purpose:** Confirms redemptions when blockchain transaction is detected.

---

## Best Practices

### For App Integration:

1. **Always use idempotency keys** for redemptions (generate UUID v4)
2. **Get fresh price** from `/api/price/wealth` before redemption
3. **Poll redemption status** after submission or use webhooks
4. **Handle 401** by redirecting to Privy login
5. **Cache merchant/voucher lists** for 60 seconds

### For Back-office Integration:

1. **Check role** before showing owner-only features
2. **Validate all input** client-side before submission
3. **Handle 403** by showing "Insufficient permissions" message
4. **Refresh token** when approaching expiration (24h)
5. **Use pagination** for large lists

### Security:

- ✅ All admin actions require authentication
- ✅ Owner-only routes enforce role check
- ✅ User data is scoped (can only see own redemptions)
- ✅ Rate limiting prevents brute force
- ✅ JWT tokens expire after 24 hours
- ✅ Passwords hashed with bcrypt
- ✅ All input validated with Zod schemas
- ✅ SQL injection protected by Prisma

---

## Support & Contact

For API issues or questions:
- GitHub: [your-repo-url]
- Email: support@example.com

**API Status:** https://status.your-api.com

---

**End of Documentation**
