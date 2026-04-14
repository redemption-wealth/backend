# Production Setup Guide

> **Panduan lengkap untuk initialize backend di production environment**

## Table of Contents

1. [Overview](#overview)
2. [Prerequisites](#prerequisites)
3. [Method 1: One-Time Setup Endpoint (Recommended)](#method-1-one-time-setup-endpoint-recommended)
4. [Method 2: Prisma Seed Script](#method-2-prisma-seed-script)
5. [Method 3: Via Vercel CLI](#method-3-via-vercel-cli)
6. [Post-Setup Tasks](#post-setup-tasks)
7. [Troubleshooting](#troubleshooting)

---

## Overview

Saat pertama kali deploy backend ke production, database kosong dan tidak ada admin account untuk login. Guide ini menjelaskan cara membuat **initial Owner account** dan data yang diperlukan.

**What Gets Created:**
- ✅ Owner account (full system access)
- ✅ App settings (fee configuration, contract addresses)
- ✅ Default gas fee setting (Rp 5,000)
- ✅ 6 merchant categories

---

## Prerequisites

Sebelum mulai, pastikan:

- ✅ Backend sudah deployed ke production (Vercel/Railway/etc)
- ✅ Database sudah running dan accessible
- ✅ Environment variables sudah di-set (DATABASE_URL, dll)
- ✅ Migration sudah applied (`prisma migrate deploy` in build step)

---

## Method 1: One-Time Setup Endpoint (Recommended)

**Best for:** Vercel, serverless deployments, atau ketika tidak ada direct database access.

### Step 1: Set SETUP_KEY Environment Variable

Di production environment (Vercel Dashboard → Settings → Environment Variables), tambahkan:

```bash
SETUP_KEY=your-secure-random-key-here
```

**Generate secure random key:**
```bash
# Via Node.js
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Via OpenSSL
openssl rand -hex 32
```

**Example:**
```
SETUP_KEY=a7f3d8e9c4b2a1f6e5d7c8b9a0f1e2d3c4b5a6f7e8d9c0b1a2f3e4d5c6b7a8f9
```

### Step 2: Deploy Backend

Pastikan backend deployed dengan setup endpoint aktif. Check di Vercel Deployments atau:

```bash
curl https://your-production-url.com/api/health
```

### Step 3: Call Setup Endpoint

**Via cURL:**

```bash
curl -X POST https://your-production-url.com/api/setup/init-owner \
  -H "Content-Type: application/json" \
  -d '{
    "email": "owner@yourcompany.com",
    "password": "YourSecurePassword123!",
    "setupKey": "a7f3d8e9c4b2a1f6e5d7c8b9a0f1e2d3c4b5a6f7e8d9c0b1a2f3e4d5c6b7a8f9"
  }'
```

**Via Postman/Insomnia:**

```
POST https://your-production-url.com/api/setup/init-owner
Content-Type: application/json

{
  "email": "owner@yourcompany.com",
  "password": "YourSecurePassword123!",
  "setupKey": "a7f3d8e9c4b2a1f6e5d7c8b9a0f1e2d3c4b5a6f7e8d9c0b1a2f3e4d5c6b7a8f9"
}
```

**Success Response:**
```json
{
  "success": true,
  "message": "Owner account created successfully",
  "owner": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "email": "owner@yourcompany.com",
    "role": "owner"
  }
}
```

**Error Responses:**

```json
// Owner already exists
{
  "error": "Owner already exists. Setup already completed."
}

// Invalid setup key
{
  "error": "Invalid setup key"
}

// Missing SETUP_KEY env variable
{
  "error": "Setup endpoint not configured. Set SETUP_KEY env variable."
}
```

### Step 4: Verify Owner Login

Test login dengan credentials yang baru dibuat:

```bash
curl -X POST https://your-production-url.com/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "owner@yourcompany.com",
    "password": "YourSecurePassword123!"
  }'
```

**Success Response:**
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "admin": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "email": "owner@yourcompany.com",
    "role": "owner"
  }
}
```

### Step 5: Delete Setup Endpoint (CRITICAL!)

⚠️ **PENTING:** Hapus setup endpoint setelah berhasil untuk keamanan!

**Option A: Remove completely**

1. Delete file:
   ```bash
   rm src/routes/setup.ts
   ```

2. Remove dari `src/app.ts`:
   ```typescript
   // Remove this line:
   import setupRoutes from "./routes/setup.js";

   // Remove this line:
   app.route("/api/setup", setupRoutes);
   ```

3. Commit & deploy:
   ```bash
   git add -A
   git commit -m "chore: Remove setup endpoint after production initialization"
   git push
   ```

**Option B: Comment out (easier to re-enable if needed)**

Di `src/app.ts`:
```typescript
// Setup endpoint - disabled after initial setup
// import setupRoutes from "./routes/setup.js";

// Public routes
app.route("/api/auth", authRoutes);
// ... other routes ...
// app.route("/api/setup", setupRoutes); // Disabled
```

### Step 6: Verify Endpoint Removed

```bash
curl -X POST https://your-production-url.com/api/setup/init-owner \
  -H "Content-Type: application/json" \
  -d '{"email":"test","password":"test","setupKey":"test"}'

# Should return 404 Not Found
```

---

## Method 2: Prisma Seed Script

**Best for:** Direct database access, Railway, self-hosted servers.

### Step 1: Set Environment Variables

Create `.env.production` file or export in shell:

```bash
export DATABASE_URL="postgresql://user:password@host:5432/database"
export INITIAL_OWNER_EMAIL="owner@yourcompany.com"
export INITIAL_OWNER_PASSWORD="YourSecurePassword123!"
export WEALTH_CONTRACT_ADDRESS="0x1234..." # Optional
export DEV_WALLET_ADDRESS="0x5678..." # Optional
```

### Step 2: Run Seed Script

```bash
# Load production env
source .env.production

# Or use dotenv
DATABASE_URL="postgresql://..." pnpm prisma db seed
```

### Step 3: Verify

```bash
# Check if owner created
psql $DATABASE_URL -c "SELECT email, role FROM admins WHERE role = 'owner';"
```

**Output:**
```
         email          | role
------------------------+-------
 owner@yourcompany.com | owner
```

---

## Method 3: Via Vercel CLI

**Best for:** Vercel deployments with local CLI access.

### Step 1: Install Vercel CLI

```bash
npm install -g vercel
```

### Step 2: Login & Link Project

```bash
# Login to Vercel
vercel login

# Navigate to project directory
cd /path/to/backend

# Link to production project
vercel link
```

### Step 3: Pull Production Environment

```bash
# Download production env vars to .env.production.local
vercel env pull .env.production.local
```

### Step 4: Set Owner Credentials

Add to `.env.production.local`:

```bash
INITIAL_OWNER_EMAIL=owner@yourcompany.com
INITIAL_OWNER_PASSWORD=YourSecurePassword123!
```

### Step 5: Run Seed

```bash
# Load env and run seed
set -a
source .env.production.local
set +a

pnpm prisma db seed
```

**Output:**
```
✅ Seeded test accounts:
   Owner: owner@yourcompany.com / YourSecurePassword123!
   Manager: manager@wealthcrypto.fund / manager-test-password
   Admin: admin@wealthcrypto.fund / admin-test-password

✅ Seeded test merchant: Test Merchant (ID: xxx)
✅ Seeded app settings (singleton)
✅ Seeded default fee setting
✅ Seeded 6 categories
```

---

## Post-Setup Tasks

### 1. Create Manager & Admin Accounts

Login sebagai Owner dan create Manager/Admin via admin panel atau API:

```bash
# Create Manager
curl -X POST https://your-production-url.com/api/admin/admins \
  -H "Authorization: Bearer $OWNER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "manager@yourcompany.com",
    "password": "ManagerPassword123!",
    "role": "manager",
    "merchantId": "merchant-uuid-here"
  }'

# Create Admin
curl -X POST https://your-production-url.com/api/admin/admins \
  -H "Authorization: Bearer $OWNER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@yourcompany.com",
    "password": "AdminPassword123!",
    "role": "admin",
    "merchantId": "merchant-uuid-here"
  }'
```

### 2. Update App Settings

Set production contract addresses:

```bash
curl -X PUT https://your-production-url.com/api/admin/settings \
  -H "Authorization: Bearer $OWNER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "appFeeRate": 3,
    "wealthContractAddress": "0x1234567890123456789012345678901234567890",
    "devWalletAddress": "0x0987654321098765432109876543210987654321",
    "alchemyRpcUrl": "https://eth-mainnet.g.alchemy.com/v2/your-key",
    "coingeckoApiKey": "your-coingecko-api-key"
  }'
```

### 3. Create Merchants

```bash
curl -X POST https://your-production-url.com/api/admin/merchants \
  -H "Authorization: Bearer $OWNER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Merchant Name",
    "address": "Jl. Example No. 123",
    "phone": "+6281234567890",
    "categoryId": "kuliner"
  }'
```

### 4. Update Owner Password

**IMPORTANT:** Change dari default password ke password yang kuat:

```bash
curl -X PUT https://your-production-url.com/api/admin/admins/me/password \
  -H "Authorization: Bearer $OWNER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "currentPassword": "YourSecurePassword123!",
    "newPassword": "NewVerySecurePassword456!"
  }'
```

---

## Troubleshooting

### Problem: "Owner already exists" error

**Solution:** Owner sudah dibuat sebelumnya. Check database:

```sql
SELECT email, role FROM admins WHERE role = 'owner';
```

Jika perlu reset (⚠️ HATI-HATI di production):

```sql
-- Delete existing owner (DANGEROUS!)
DELETE FROM admins WHERE role = 'owner' AND email = 'old@email.com';

-- Then run setup again
```

### Problem: "Setup endpoint not configured"

**Solution:** `SETUP_KEY` env variable belum di-set. Tambahkan di Vercel Dashboard atau deployment platform.

### Problem: "Invalid setup key"

**Solution:** setupKey di request body tidak match dengan `SETUP_KEY` env variable. Pastikan sama persis (case-sensitive).

### Problem: Setup endpoint returns 404

**Solution:**
1. Check apakah route sudah registered di `src/app.ts`
2. Check apakah deployment berhasil
3. Check URL endpoint benar: `/api/setup/init-owner`

### Problem: Seed script fails with migration error

**Solution:** Run migrations first:

```bash
pnpm prisma migrate deploy
pnpm prisma generate
pnpm prisma db seed
```

### Problem: "Foreign key constraint violation" di seed

**Solution:** Categories belum dibuat. Seed script sekarang sudah handle ini dengan create categories first.

---

## Security Checklist

Before going to production:

- [ ] `SETUP_KEY` is a cryptographically random 32+ byte string
- [ ] Setup endpoint deleted or disabled after initial setup
- [ ] Owner password is strong (12+ chars, mixed case, numbers, symbols)
- [ ] Owner password changed from initial setup password
- [ ] `DATABASE_URL` uses SSL connection (`sslmode=require`)
- [ ] All sensitive env variables (API keys, secrets) are set in production
- [ ] CORS origins restricted to production domains only
- [ ] Rate limiting enabled for auth endpoints
- [ ] Logs don't contain sensitive information

---

## Quick Reference

### Production Credentials (Default Seed)

```
Owner:
  Email: owner@wealthcrypto.fund
  Password: change-me-on-first-login

Manager (Test):
  Email: manager@wealthcrypto.fund
  Password: manager-test-password

Admin (Test):
  Email: admin@wealthcrypto.fund
  Password: admin-test-password
```

**⚠️ CHANGE ALL DEFAULT PASSWORDS IN PRODUCTION!**

### API Endpoints Reference

```
POST /api/setup/init-owner          # One-time setup (delete after use)
POST /api/auth/login                # Admin login
GET  /api/admin/admins/me           # Get current admin info
POST /api/admin/admins              # Create new admin (owner only)
PUT  /api/admin/settings            # Update app settings (owner only)
```

### Environment Variables Checklist

```bash
# Required
DATABASE_URL=postgresql://...
JWT_SECRET=random-32-byte-hex
PRIVY_APP_ID=your-privy-app-id
PRIVY_APP_SECRET=your-privy-secret

# For setup endpoint
SETUP_KEY=random-32-byte-hex

# Optional (for owner creation)
INITIAL_OWNER_EMAIL=owner@company.com
INITIAL_OWNER_PASSWORD=secure-password

# Contract addresses
WEALTH_CONTRACT_ADDRESS=0x...
DEV_WALLET_ADDRESS=0x...

# External services
ALCHEMY_RPC_URL=https://...
ALCHEMY_WEBHOOK_SIGNING_KEY=xxx
COINGECKO_API_KEY=xxx

# R2 Storage
R2_ACCOUNT_ID=xxx
R2_ACCESS_KEY_ID=xxx
R2_SECRET_ACCESS_KEY=xxx
R2_QR_BUCKET_NAME=wealth-qr-codes

# CORS
CORS_ORIGINS=https://app.wealthcrypto.fund,https://admin.wealthcrypto.fund
```

---

## Support

Jika ada masalah selama production setup:

1. Check Vercel/platform logs untuk error details
2. Verify database connection dengan `psql $DATABASE_URL`
3. Test migrations dengan `pnpm prisma migrate status`
4. Review this guide's troubleshooting section
5. Contact backend team

---

**Last Updated:** 2026-04-15
**Version:** 1.0.0
