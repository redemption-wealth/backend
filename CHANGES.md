# Backend API Enhancements - Implementation Summary

## ✅ Completed Features

### 1. Simplified Category Table
- **Removed:** icon, sortOrder, description, displayName
- **Kept:** id, name, isActive, timestamps
- More efficient database design

### 2. Table-Based Categories (Migration from Enum)
- Merchant.category (enum) → Merchant.categoryId (FK to Category)
- Removed MerchantCategory enum completely
- Dynamic category management without schema changes

### 3. File Upload System (R2 Storage)

#### Logo Upload
- **Endpoint:** `POST /api/admin/upload/logo`
- **Storage:** Public R2 bucket
- **Limits:** 5MB, images only
- **Returns:** Public URL

#### QR ZIP Upload
- **Endpoint:** `POST /api/admin/vouchers/:id/upload-qr`
- **Storage:** Private R2 bucket (signed URLs)
- **Validation:**
  - PNG only
  - Flat structure
  - Count must match totalStock × qrPerRedemption
  - No duplicate imageHash
- **Transaction-safe:** Auto-rollback on failure

### 4. Analytics Endpoints (5-min cache)

All require owner authentication:

- `GET /api/admin/analytics/summary` - Extended with totalUsers, avgWealthPerRedeem, totalValueIdr
- `GET /api/admin/analytics/redemptions-over-time?period=daily` - Daily/weekly/monthly redemption trends
- `GET /api/admin/analytics/merchant-categories` - Pie chart data
- `GET /api/admin/analytics/wealth-volume?period=monthly` - Bar chart data
- `GET /api/admin/analytics/top-merchants?limit=3` - Leaderboard
- `GET /api/admin/analytics/top-vouchers?limit=3` - Leaderboard
- `GET /api/admin/analytics/treasury-balance` - Stub for blockchain integration

### 5. Auth Enhancement
- `POST /api/auth/login` returns `403` with `code: "PASSWORD_NOT_SET"` when admin password is null
- Enables first-login detection for frontend

## 📦 Dependencies Added

```json
{
  "@aws-sdk/client-s3": "^3.1029.0",
  "@aws-sdk/s3-request-presigner": "^3.1029.0",
  "adm-zip": "^0.5.17",
  "file-type": "^22.0.1",
  "node-cache": "^5.1.2",
  "viem": "^2.47.12",
  "@types/adm-zip": "^0.5.8" (dev)
}
```

## 🔧 Environment Variables Required

```bash
# Cloudflare R2
CLOUDFLARE_ACCOUNT_ID=<your_account_id>
R2_ACCESS_KEY_ID=<your_access_key>
R2_SECRET_ACCESS_KEY=<your_secret_key>
R2_LOGO_BUCKET_NAME=wealth-merchant-logos
R2_QR_BUCKET_NAME=wealth-qr-codes
R2_LOGO_PUBLIC_URL=https://pub-<hash>.r2.dev

# Alchemy (for future treasury balance)
ALCHEMY_API_KEY=<your_alchemy_api_key>
ALCHEMY_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/<ALCHEMY_API_KEY>
ETHEREUM_CHAIN_ID=1
```

## ⚠️ Breaking Changes

### Category API
**Before:**
```json
{
  "id": "uuid",
  "name": "kuliner",
  "displayName": "Kuliner",
  "icon": "🍔",
  "sortOrder": 1
}
```

**After:**
```json
{
  "id": "uuid",
  "name": "kuliner"
}
```

### Merchant API
**Query Parameter Change:**
- Before: `?category=kuliner`
- After: `?categoryId=<uuid>`

**Create/Update Payload:**
- Before: `{ "category": "kuliner" }`
- After: `{ "categoryId": "<uuid>" }`

**Response includes category relation:**
```json
{
  "id": "uuid",
  "name": "Merchant",
  "categoryId": "uuid",
  "category": {
    "name": "kuliner"
  }
}
```

## 🧪 Testing Checklist

- [ ] Logo upload with various formats/sizes
- [ ] QR ZIP upload (valid and invalid cases)
- [ ] Analytics endpoints return correct data
- [ ] Category filtering works with categoryId
- [ ] Auth PASSWORD_NOT_SET flow
- [ ] Database migration successful
- [ ] Build passes

## 📝 API Documentation

Full API documentation update needed for:
- File upload endpoints
- New analytics endpoints
- Updated category responses
- Updated merchant query parameters
- Auth error code

## 🚀 Deployment Notes

1. Environment variables must be set before deployment
2. R2 buckets must be created and configured
3. Database migration automatically applied via `db push`
4. No manual data migration needed (handled by Prisma)

## 🔗 Related

- R2 Setup Guide: See brainstorm document
- Alchemy Setup: See brainstorm document
- Treasury Balance: Implementation deferred to Phase 2
