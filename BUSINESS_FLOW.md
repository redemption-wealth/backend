# Wealth Redemption System - Business Flow Documentation

> **Version:** 1.0.0
> **Last Updated:** April 13, 2026
> **Status:** ⚠️ Undergoing Refactor (QR Generation Flow)

---

## Table of Contents

1. [System Overview](#system-overview)
2. [Architecture & Tech Stack](#architecture--tech-stack)
3. [Core Domain Models](#core-domain-models)
4. [User Redemption Flow](#user-redemption-flow)
5. [Admin Management Flow](#admin-management-flow)
6. [QR Code System](#qr-code-system)
7. [Payment & Blockchain Integration](#payment--blockchain-integration)
8. [Authentication & Authorization](#authentication--authorization)
9. [Analytics & Reporting](#analytics--reporting)
10. [API Reference](#api-reference)
11. [Frontend Integration Guide](#frontend-integration-guide)
12. [Error Handling & Edge Cases](#error-handling--edge-cases)

---

## System Overview

### What is Wealth Redemption?

Wealth Redemption is a **blockchain-integrated voucher redemption platform** that enables users to purchase and redeem merchant vouchers using the **$WEALTH cryptocurrency token**. The system bridges traditional voucher systems with Web3 payments.

### Key Features

- 🎫 **Digital Voucher System** - Merchants create vouchers with stock management
- 🔐 **QR Code Verification** - Secure, scannable QR codes for redemption verification
- 💰 **Crypto Payments** - Pay with $WEALTH token via embedded wallets
- 👥 **Multi-Role Admin** - Owner, Manager, and Admin hierarchy
- 📊 **Analytics Dashboard** - Real-time reporting and insights
- ⛓️ **Blockchain Tracking** - Alchemy webhooks for transaction confirmation

### Key Stakeholders

| Stakeholder | Role | Primary Actions |
|-------------|------|-----------------|
| **End User** | Voucher consumer | Browse vouchers, redeem with crypto, scan QR at merchant |
| **Merchant** | Voucher provider | Offer vouchers, scan customer QR codes |
| **Admin** | Merchant staff | Manage vouchers, scan QR codes (scoped to merchant) |
| **Manager** | Platform operator | Create merchants, configure fees, view analytics |
| **Owner** | System administrator | Full system control, settings, analytics |

---

## Architecture & Tech Stack

### Backend Stack

- **Framework:** Hono (lightweight edge-optimized)
- **Runtime:** Node.js 20+
- **Language:** TypeScript
- **Database:** PostgreSQL (via Supabase)
- **ORM:** Prisma 7.7.0
- **Authentication:**
  - User: Privy (embedded wallet + email)
  - Admin: JWT (HS256) + bcrypt
- **Storage:** Cloudflare R2 (S3-compatible)
- **Blockchain:** Ethereum mainnet
- **Webhook:** Alchemy (transaction monitoring)
- **Caching:** Node-cache (5-minute TTL)

### Frontend Stack

| Application | Technology | Users | Purpose |
|-------------|-----------|-------|---------|
| **Backoffice** | Vite | Admin, Manager, Owner | Merchant & voucher management |
| **App** | React (Web) | End Users | Browse & redeem vouchers |

### System Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│ FRONTENDS                                                    │
├─────────────────────────────────────────────────────────────┤
│ App (React)              │  Backoffice (Vite)               │
│ - Browse vouchers        │  - Manage merchants              │
│ - Redeem with crypto     │  - Create vouchers               │
│ - View redemptions       │  - Scan QR codes                 │
│                          │  - View analytics                │
└──────────┬───────────────┴─────────────┬────────────────────┘
           │                             │
           │  Privy Auth                 │  JWT Auth
           │                             │
           ↓                             ↓
┌─────────────────────────────────────────────────────────────┐
│ BACKEND API (Hono)                                          │
├─────────────────────────────────────────────────────────────┤
│ Public Routes    │ User Routes      │ Admin Routes         │
│ - Vouchers       │ - Redemptions    │ - Merchants          │
│ - Merchants      │ - Transactions   │ - Vouchers (CRUD)    │
│ - Categories     │ - User sync      │ - QR Management      │
│ - Price API      │                  │ - Analytics          │
└──────────┬──────────────────┬─────────────────┬─────────────┘
           │                  │                 │
           ↓                  ↓                 ↓
┌─────────────────┐  ┌─────────────────┐  ┌──────────────────┐
│ PostgreSQL      │  │ Cloudflare R2   │  │ Alchemy Webhook  │
│ (Supabase)      │  │ (QR Images)     │  │ (TX Monitoring)  │
└─────────────────┘  └─────────────────┘  └──────────────────┘
```

---

## Core Domain Models

### Entity Relationship Overview

```
User (1) ──────── (N) Redemption ──────── (1) Voucher
  │                      │                      │
  │                      │                      ├── (1) Merchant
  │                      │                      │       │
  │                      │                      │       ├── (1) Category
  │                      │                      │       └── (N) Admin (assigned)
  │                      │                      │
  │                      └──────────── (N) QrCode
  │
  └──────────────────── (N) QrCode (assignedTo)
                              │
                              └──────── (1) Admin (scannedBy)

Admin (1) ──────── (N) Merchant (createdBy)
Admin (N) ←──────→ (N) Merchant (assignedAdmins) [Many-to-Many]

Redemption (1) ──── (1) Transaction
```

### Key Entities

#### **User**
```typescript
{
  id: string
  email: string
  privyUserId: string        // External auth ID
  walletAddress: string?     // Ethereum address (embedded wallet)
  createdAt: DateTime
  updatedAt: DateTime
}
```

**Purpose:** End users who browse and redeem vouchers using crypto.

---

#### **Admin**
```typescript
{
  id: string
  email: string
  passwordHash: string?      // Nullable for first-time setup
  role: "owner" | "manager" | "admin"
  merchantId: string?        // Required for 'admin' role
  isActive: boolean
  createdAt: DateTime
  updatedAt: DateTime
}
```

**Role Hierarchy:**
- **Owner:** Full system access, manages all merchants and settings
- **Manager:** Can create merchants, configure fees, view system-wide analytics
- **Admin:** Scoped to single merchant, manages vouchers and scans QR codes

---

#### **Merchant**
```typescript
{
  id: string
  name: string
  categoryId: string
  logoUrl: string?
  description: string?
  isActive: boolean
  createdBy: string?         // Admin who created this merchant
  assignedAdmins: Admin[]    // Many-to-many: admins with access
  createdAt: DateTime
  updatedAt: DateTime
}
```

**Purpose:** Businesses offering vouchers (e.g., coffee shops, restaurants, concert venues).

---

#### **Voucher**
```typescript
{
  id: string
  merchantId: string
  title: string
  description: string?
  startDate: DateTime
  endDate: DateTime
  totalStock: int            // Total vouchers available
  usedStock: int             // Vouchers redeemed and confirmed
  priceIdr: int              // Price in Indonesian Rupiah
  qrPerRedemption: int       // QR codes per voucher (e.g., 2 for "Buy 1 Get 1")
  isActive: boolean
  createdAt: DateTime
  updatedAt: DateTime
}
```

**Stock Calculation:**
```typescript
availableStock = (totalQrCodes with status='available') / qrPerRedemption
assignedStock = (totalQrCodes with status='assigned') / qrPerRedemption
usedStock = stored in DB (incremented on confirmation)
```

**Display Format:** `"50 used / 100 total"` or `"48 available"`

---

#### **QrCode**

> ⚠️ **NEW FLOW (Post-Refactor):** QR codes are generated when admin creates voucher, not during user redemption.

```typescript
{
  id: string
  voucherId: string
  redemptionId: string?      // Linked when assigned to user
  token: string              // 32-char hex (unique)
  imageUrl: string?          // R2 path (lazy-loaded on assignment)
  imageHash: string?         // SHA256 (lazy-loaded on assignment)
  status: "available" | "assigned" | "used"
  assignedToUserId: string?
  assignedAt: DateTime?
  usedAt: DateTime?
  scannedByAdminId: string?
  createdAt: DateTime
  updatedAt: DateTime
}
```

**Status Transitions:**
```
available  →  assigned  →  used
   ↑             ↓
   └─── (recycle on fail)
```

**Lifecycle:**
1. **Admin creates voucher** → Generate N QR tokens (status: `available`)
2. **User redeems voucher** → Assign N QR codes (status: `assigned`)
3. **Admin scans QR** → Mark as used (status: `used`)
4. **Redemption fails** → Recycle QR (status: `available`)

---

#### **Redemption**
```typescript
{
  id: string
  userId: string
  voucherId: string
  status: "pending" | "confirmed" | "failed"
  wealthAmount: Decimal      // Total WEALTH tokens to pay
  appFeeAmount: Decimal      // App fee in WEALTH
  gasFeeAmount: Decimal      // Gas fee in WEALTH
  priceIdrAtRedeem: int      // Voucher price locked at redemption
  wealthPriceIdrAtRedeem: Decimal // $WEALTH price locked
  txHash: string?            // Blockchain transaction hash
  idempotencyKey: string     // Client-generated UUID (per-user unique)
  qrPerRedemption: int
  scannedQrCount: int
  confirmedAt: DateTime?
  createdAt: DateTime
  updatedAt: DateTime
}
```

**Status Flow:**
```
pending  →  confirmed  (on Alchemy webhook success)
pending  →  failed     (on Alchemy webhook failure)
```

---

#### **Transaction**
```typescript
{
  id: string
  redemptionId: string       // One-to-one with Redemption
  transactionHash: string
  amount: string             // WEALTH amount
  type: "redeem"
  status: "confirmed"
  fromAddress: string        // User's embedded wallet
  toAddress: string          // Treasury wallet
  blockNumber: int?
  createdAt: DateTime
  updatedAt: DateTime
}
```

**Purpose:** Immutable record of confirmed blockchain transactions.

---

## User Redemption Flow

### Complete Journey: Discovery → Redemption → Verification

```
┌─────────────────────────────────────────────────────────────┐
│ PHASE 1: DISCOVERY                                           │
└─────────────────────────────────────────────────────────────┘

User opens App (React)
  ↓
GET /api/vouchers?page=1&limit=20
  Response: [
    {
      id: "uuid",
      title: "Coffee 50% Off",
      priceIdr: 25000,
      availableStock: 48,
      totalStock: 100,
      usedStock: 50,
      isAvailable: true,
      merchant: { name: "Coffee Shop A", logoUrl: "..." }
    }
  ]
  ↓
User clicks voucher to view details
  ↓
GET /api/vouchers/:id
  Response: {
    voucher: { ...full details, merchant info },
    availableStock: 48
  }


┌─────────────────────────────────────────────────────────────┐
│ PHASE 2: AUTHENTICATION                                      │
└─────────────────────────────────────────────────────────────┘

User clicks "Redeem"
  ↓
Frontend checks auth status
  ↓
If not authenticated:
  ↓
  User logs in with Privy (email or social)
    ↓
  Privy creates embedded wallet
    ↓
  Frontend receives Privy auth token + wallet address
    ↓
  POST /api/auth/user-sync
    Headers: { Authorization: "Bearer <privy-token>" }
    ↓
  Backend verifies token with Privy
  Backend upserts User record:
    - email from Privy
    - privyUserId from Privy
    - walletAddress from Privy
    ↓
  Response: { user: { id, email, walletAddress } }


┌─────────────────────────────────────────────────────────────┐
│ PHASE 3: PRICE CALCULATION                                   │
└─────────────────────────────────────────────────────────────┘

Frontend fetches current WEALTH price
  ↓
GET /api/price/wealth
  Response: { priceIdr: 250.50 } // 1 WEALTH = 250.50 IDR
  ↓
Calculate total cost:
  Base Price: 25,000 IDR
  App Fee (3%): 750 IDR
  Gas Fee: 5,000 IDR
  ────────────────────
  Total: 30,750 IDR

  WEALTH Amount: 30,750 / 250.50 = 122.754 WEALTH
  ↓
Display to user:
  "You will pay: 122.754 WEALTH (~30,750 IDR)"


┌─────────────────────────────────────────────────────────────┐
│ PHASE 4: REDEMPTION INITIATION                               │
└─────────────────────────────────────────────────────────────┘

User confirms redemption
  ↓
Frontend generates idempotencyKey (UUID v4)
  ↓
POST /api/vouchers/:id/redeem
  Headers: { Authorization: "Bearer <privy-token>" }
  Body: {
    idempotencyKey: "550e8400-e29b-41d4-a716-446655440000",
    wealthPriceIdr: 250.50
  }
  ↓
Backend processing:
  1. Check idempotency (return existing if duplicate)
  2. Validate voucher (active, not expired, stock available)
  3. Find N available QR codes (where status='available')
  4. Calculate pricing (lock prices)
  5. Create Redemption record (status: 'pending')
  6. Assign QR codes to user (update status: 'assigned')
  7. Generate QR images (lazy-load, upload to R2)
  ↓
Response: {
  redemption: {
    id: "redemption-uuid",
    status: "pending",
    wealthAmount: "122.754",
    qrCodes: [
      {
        id: "qr-uuid",
        token: "abc123def456...",
        imageUrl: "qr-codes/voucher-id/qr-id.png",
        status: "assigned"
      }
    ]
  },
  txDetails: {
    tokenContractAddress: "0x123abc...",
    treasuryWalletAddress: "0x789def...",
    wealthAmount: "122.754000000000000000"
  }
}


┌─────────────────────────────────────────────────────────────┐
│ PHASE 5: BLOCKCHAIN TRANSACTION                              │
└─────────────────────────────────────────────────────────────┘

Frontend displays transaction confirmation
  ↓
User reviews:
  - Amount: 122.754 WEALTH
  - Recipient: Treasury Wallet (0x789def...)
  - Contract: WEALTH Token (0x123abc...)
  ↓
User signs transaction with embedded wallet
  ↓
Frontend submits to Ethereum network
  ↓
Blockchain returns txHash: "0xaabbccdd..."
  ↓
Frontend stores txHash locally


┌─────────────────────────────────────────────────────────────┐
│ PHASE 6: TX HASH SUBMISSION                                  │
└─────────────────────────────────────────────────────────────┘

PATCH /api/redemptions/:id/submit-tx
  Headers: { Authorization: "Bearer <privy-token>" }
  Body: { txHash: "0xaabbccdd..." }
  ↓
Backend validation:
  - txHash format (0x + 64 hex chars)
  - txHash uniqueness (not used before)
  - Redemption status = 'pending'
  - User owns this redemption
  ↓
Backend updates redemption.txHash
  ↓
Response: { redemption: { ...updated } }
  ↓
Frontend shows:
  "Transaction submitted! Waiting for confirmation..."
  "TxHash: 0xaabbccdd..."


┌─────────────────────────────────────────────────────────────┐
│ PHASE 7: BLOCKCHAIN CONFIRMATION (Async)                     │
└─────────────────────────────────────────────────────────────┘

Time: T+1-5 minutes (depends on network)
  ↓
Alchemy detects transaction on-chain
  ↓
POST /api/webhook/alchemy
  Body: {
    event: {
      activity: [{
        hash: "0xaabbccdd...",
        category: "token",
        typeTraceAddress: "CALL"
      }]
    }
  }
  ↓
Backend webhook processing:
  For each activity:
    Try: confirmRedemption(txHash)
    Catch: failRedemption(txHash)
  ↓
confirmRedemption():
  1. Find redemption by txHash (status='pending')
  2. Update redemption:
     - status: 'pending' → 'confirmed'
     - confirmedAt: now()
  3. Increment voucher.usedStock
  4. Create Transaction record
  ↓
Response: { ok: true }


┌─────────────────────────────────────────────────────────────┐
│ PHASE 8: USER VERIFICATION                                   │
└─────────────────────────────────────────────────────────────┘

Frontend polls redemption status (every 5-10 seconds)
  ↓
GET /api/redemptions/:id
  Response: {
    redemption: {
      status: "confirmed", ✓
      confirmedAt: "2026-04-13T10:30:00Z",
      qrCodes: [
        {
          token: "abc123def456...",
          imageUrl: "https://r2.../qr-codes/...",
          status: "assigned" // Ready to scan
        }
      ]
    }
  }
  ↓
Frontend displays:
  "✓ Redemption Confirmed!"
  "Show this QR code at the merchant:"
  [QR Code Image Display]


┌─────────────────────────────────────────────────────────────┐
│ PHASE 9: MERCHANT SCAN (At Store)                            │
└─────────────────────────────────────────────────────────────┘

Customer arrives at merchant location
  ↓
Customer shows QR code on phone
  ↓
Merchant admin opens Backoffice
  ↓
Admin scans QR code (camera or barcode reader)
  ↓
Extracts token: "abc123def456..."
  ↓
POST /api/admin/qr-codes/scan
  Headers: { Authorization: "Bearer <admin-jwt>" }
  Body: { token: "abc123def456..." }
  ↓
Backend processing:
  1. Find QR code by token
  2. Validate admin access (merchant ownership)
  3. Check QR status = 'assigned'
  4. Update QR: status → 'used', usedAt = now(), scannedByAdminId
  ↓
Response: {
  success: true,
  voucherId: "voucher-uuid",
  usedAt: "2026-04-13T11:00:00Z"
}
  ↓
Backoffice displays: "✓ QR Code Verified!"
  ↓
Merchant provides service/product to customer
  ↓
Flow complete!
```

### Multi-QR Scenario (Buy 1 Get 1)

**Example:** Concert ticket voucher with `qrPerRedemption = 2`

1. User redeems voucher → receives 2 QR codes
2. User shares QR codes with friend (e.g., via screenshot/email)
3. Both users scan their QR codes at venue entrance
4. Admin scans first QR → status: `used` ✓
5. Admin scans second QR → status: `used` ✓
6. Both users enter venue

**Use Cases:**
- Concert tickets (1 voucher = 2 tickets)
- Restaurant meals (Buy 1 Get 1 Free)
- Gym passes (Bring a friend)

---

## Admin Management Flow

### Admin Role Hierarchy

```
┌──────────────────────────────────────────────────────────┐
│ OWNER (Full System Access)                               │
├──────────────────────────────────────────────────────────┤
│ ✓ Create/manage all merchants                            │
│ ✓ Create/manage all admins (owner, manager, admin)       │
│ ✓ Configure app settings (treasury, fee %)               │
│ ✓ Activate/delete fee presets                            │
│ ✓ View system-wide analytics                             │
│ ✓ Delete vouchers/merchants/admins                       │
└──────────────────────────────────────────────────────────┘
                           ↓ delegates
┌──────────────────────────────────────────────────────────┐
│ MANAGER (Platform Operations)                            │
├──────────────────────────────────────────────────────────┤
│ ✓ Create/update merchants                                │
│ ✓ Create/update fee settings                             │
│ ✓ View system-wide analytics                             │
│ ✗ Cannot delete resources                                │
│ ✗ Cannot manage admins                                   │
└──────────────────────────────────────────────────────────┘
                           ↓ assigns
┌──────────────────────────────────────────────────────────┐
│ ADMIN (Merchant-Scoped)                                  │
├──────────────────────────────────────────────────────────┤
│ ✓ Create/update vouchers (own merchant only)             │
│ ✓ Scan QR codes (own merchant only)                      │
│ ✓ View redemptions (own merchant only)                   │
│ ✗ Cannot access other merchants                          │
│ ✗ Cannot view system-wide analytics                      │
│ ✗ Cannot manage settings                                 │
└──────────────────────────────────────────────────────────┘
```

### Admin Authentication Flow

```
┌─────────────────────────────────────────────────────────────┐
│ SCENARIO 1: First-Time Login (No Password Set)              │
└─────────────────────────────────────────────────────────────┘

Owner creates new admin
  ↓
POST /api/admin/admins
  Headers: { Authorization: "Bearer <owner-jwt>" }
  Body: {
    email: "admin@merchant.com",
    role: "admin",
    merchantId: "merchant-uuid"
    // No password field
  }
  ↓
Backend creates Admin record:
  - passwordHash: null (no password yet)
  - isActive: true
  ↓
Response: { admin: { id, email, role } }


Admin receives email invitation (manual)
  ↓
Admin opens Backoffice login page
  ↓
Admin enters email + password
  ↓
POST /api/auth/login
  Body: { email: "admin@merchant.com", password: "initial123" }
  ↓
Backend checks:
  - Admin exists? ✓
  - passwordHash is null? YES
  ↓
Response: {
  error: "PASSWORD_NOT_SET",
  message: "Please set your password first"
}
  ↓
Frontend redirects to: /set-password?email=admin@merchant.com


Admin sets password
  ↓
POST /api/auth/set-password
  Body: {
    email: "admin@merchant.com",
    password: "SecurePass123!"
  }
  ↓
Backend:
  1. Find admin by email
  2. Check passwordHash is null (first-time only)
  3. Hash password with bcrypt (12 rounds)
  4. Update admin.passwordHash
  ↓
Response: { message: "Password set successfully" }
  ↓
Frontend redirects to: /login


┌─────────────────────────────────────────────────────────────┐
│ SCENARIO 2: Normal Login (Password Already Set)             │
└─────────────────────────────────────────────────────────────┘

Admin enters credentials
  ↓
POST /api/auth/login
  Body: { email, password }
  ↓
Backend validation:
  1. Find admin by email
  2. Check isActive = true
  3. Verify password with bcrypt
  4. Generate JWT (HS256, 24h expiry)
     Payload: { id, email, role, merchantId }
  ↓
Response: {
  token: "eyJhbGciOi...",
  admin: { id, email, role, merchantId }
}
  ↓
Frontend stores token in localStorage/sessionStorage
  ↓
All subsequent requests include:
  Headers: { Authorization: "Bearer <token>" }


┌─────────────────────────────────────────────────────────────┐
│ SCENARIO 3: Token Validation (Every Request)                │
└─────────────────────────────────────────────────────────────┘

Admin makes API request
  ↓
requireAdmin middleware:
  1. Extract JWT from Authorization header
  2. Verify JWT signature & expiration
  3. Decode payload: { id, email, role, merchantId }
  4. Query DB: SELECT * FROM Admin WHERE id = payload.id
  5. Check isActive = true (instant revocation check)
  ↓
If valid:
  c.set("adminAuth", { adminId, role, merchantId })
  Continue to route handler
  ↓
If invalid:
  Return 401 Unauthorized
```

### Merchant Management

```
┌─────────────────────────────────────────────────────────────┐
│ CREATE MERCHANT (Manager+ required)                          │
└─────────────────────────────────────────────────────────────┘

POST /api/admin/merchants
  Headers: { Authorization: "Bearer <manager-jwt>" }
  Body: {
    name: "Coffee Shop A",
    categoryId: "category-uuid",
    logoUrl: "https://...",
    description: "Best coffee in town"
  }
  ↓
Backend:
  - Creates merchant record
  - Sets createdBy = adminAuth.adminId
  ↓
Response: { merchant: { id, name, ... } }


┌─────────────────────────────────────────────────────────────┐
│ ASSIGN ADMIN TO MERCHANT (Owner only)                       │
└─────────────────────────────────────────────────────────────┘

PUT /api/admin/admins/:adminId
  Headers: { Authorization: "Bearer <owner-jwt>" }
  Body: {
    merchantId: "merchant-uuid"
  }
  ↓
Backend:
  - Validates admin.role = "admin" (not owner/manager)
  - Updates admin.merchantId
  ↓
Response: { admin: { id, merchantId, ... } }
```

### Voucher Management

```
┌─────────────────────────────────────────────────────────────┐
│ CREATE VOUCHER (Admin+ required)                             │
└─────────────────────────────────────────────────────────────┘

POST /api/admin/vouchers
  Headers: { Authorization: "Bearer <admin-jwt>" }
  Body: {
    merchantId: "merchant-uuid", // Forced to adminAuth.merchantId if role=admin
    title: "50% Off All Items",
    description: "Valid for all menu items",
    startDate: "2026-01-01",
    endDate: "2026-12-31",
    totalStock: 100,
    priceIdr: 50000,
    qrPerRedemption: 1
  }
  ↓
Backend:
  1. Validate merchant ownership (admin role check)
  2. Create voucher record
  3. Generate QR codes: 100 * 1 = 100 QR tokens
     - Status: 'available'
     - No images generated yet (lazy-load)
  ↓
Response: { voucher: { id, ... }, qrCodesGenerated: 100 }


┌─────────────────────────────────────────────────────────────┐
│ UPDATE VOUCHER STOCK (Admin+ required)                       │
└─────────────────────────────────────────────────────────────┘

PUT /api/admin/vouchers/:id
  Body: {
    totalStock: 150 // Increase from 100 to 150
  }
  ↓
Backend:
  1. Calculate delta: (150 - 100) * qrPerRedemption = 50 QR codes
  2. Generate 50 additional QR tokens (status: 'available')
  ↓
Response: { voucher: { ...updated }, qrCodesAdded: 50 }

─────────────────────────────────────────────────────────────

PUT /api/admin/vouchers/:id
  Body: {
    totalStock: 50 // Decrease from 100 to 50
  }
  ↓
Backend:
  1. Calculate delta: (100 - 50) * qrPerRedemption = 50 QR codes to remove
  2. Count available QR codes: SELECT COUNT(*) WHERE status='available'
  3. If availableCount < 50:
     → Throw error: "Cannot reduce stock. Only X available QR codes."
  4. Else: Delete 50 oldest available QR codes (FIFO)
  ↓
Response: { voucher: { ...updated }, qrCodesRemoved: 50 }
```

### QR Code Scanning

```
┌─────────────────────────────────────────────────────────────┐
│ SCAN QR CODE AT MERCHANT (Admin+ required, rate-limited)    │
└─────────────────────────────────────────────────────────────┘

Admin scans customer's QR code
  ↓
Extract token from QR image: "abc123def456..."
  ↓
POST /api/admin/qr-codes/scan
  Headers: { Authorization: "Bearer <admin-jwt>" }
  Body: { token: "abc123def456..." }
  ↓
Backend processing:
  1. Find QR code by token (with voucher.merchantId)
  2. Validate merchant ownership:
     - If admin role: voucher.merchantId must = adminAuth.merchantId
     - If manager/owner: no restriction
  3. Atomic update:
     UPDATE QrCode
     SET status = 'used', usedAt = NOW(), scannedByAdminId = adminAuth.adminId
     WHERE id = qrId AND status = 'assigned'
  4. Check affected rows:
     - If 0: determine error (already used? wrong status?)
     - If 1: success
  ↓
Response (Success):
  {
    success: true,
    voucherId: "voucher-uuid",
    usedAt: "2026-04-13T10:00:00Z",
    scannedBy: "admin-uuid"
  }
  ↓
Response (Error - Already Used):
  {
    error: "ALREADY_USED",
    message: "This QR code has already been scanned",
    usedAt: "2026-04-13T09:00:00Z"
  }


Rate Limiting:
  - 60 scans per minute per admin
  - Prevents abuse/spam scanning
```

---

## QR Code System

### QR Code Lifecycle (Post-Refactor)

```
┌─────────────────────────────────────────────────────────────┐
│ STATE 1: AVAILABLE (Pre-generated Pool)                     │
└─────────────────────────────────────────────────────────────┘

Admin creates voucher (totalStock=100, qrPerRedemption=1)
  ↓
System generates 100 QR codes:
  - token: 32-char random hex (e.g., "a1b2c3d4...")
  - status: 'available'
  - imageUrl: null (not generated yet)
  - imageHash: null
  - assignedToUserId: null
  - redemptionId: null
  ↓
QR codes stored in database, ready for assignment


┌─────────────────────────────────────────────────────────────┐
│ STATE 2: ASSIGNED (User Redemption)                         │
└─────────────────────────────────────────────────────────────┘

User redeems voucher
  ↓
System finds 1 available QR code (FIFO - oldest first)
  ↓
Update QR code:
  - status: 'available' → 'assigned'
  - assignedToUserId: user.id
  - redemptionId: redemption.id
  - assignedAt: NOW()
  ↓
Generate QR image (lazy-load):
  1. Render token as PNG (512x512)
  2. Upload to R2: qr-codes/{voucherId}/{qrId}.png
  3. Calculate SHA256 hash
  4. Update QR record:
     - imageUrl: "qr-codes/..."
     - imageHash: "sha256..."
  ↓
Return QR code to user (display in app)


┌─────────────────────────────────────────────────────────────┐
│ STATE 3: USED (Merchant Scan)                               │
└─────────────────────────────────────────────────────────────┘

Admin scans QR code at merchant
  ↓
System validates and updates:
  - status: 'assigned' → 'used'
  - usedAt: NOW()
  - scannedByAdminId: admin.id
  ↓
QR code cannot be scanned again (idempotent)


┌─────────────────────────────────────────────────────────────┐
│ RECYCLING: Failed Redemption                                │
└─────────────────────────────────────────────────────────────┘

Blockchain transaction fails (detected by webhook)
  ↓
System recycles QR codes:
  - Delete image from R2 (best-effort)
  - Reset QR code:
    - status: 'assigned' → 'available'
    - assignedToUserId: null
    - redemptionId: null
    - assignedAt: null
    - imageUrl: null
    - imageHash: null
  ↓
QR code returned to available pool (reusable by another user)
```

### QR Image Generation

**Strategy:** Lazy-load (generate only when needed)

**Why Lazy-Load?**
- ✅ Fast voucher creation (no bulk image upload)
- ✅ Save R2 storage (only generate used QRs)
- ✅ Flexible scaling (generate on-demand)
- ❌ Slight delay on first redemption (acceptable trade-off)

**Image Specifications:**
- Format: PNG
- Size: 512x512 pixels
- Error Correction: High (Level H - 30% recovery)
- Margin: 2 modules
- Storage: Cloudflare R2 (S3-compatible)
- Path: `qr-codes/{voucherId}/{qrCodeId}.png`

### Security Features

1. **Unique Token:** 32-char hex (256-bit entropy) → virtually no collision risk
2. **Image Hash:** SHA256 integrity check (detect tampering)
3. **Status Validation:** Atomic updates prevent race conditions
4. **Merchant Scoping:** Admin can only scan their merchant's QR codes
5. **Idempotent Scanning:** Re-scanning returns error (not destructive)

---

## Payment & Blockchain Integration

### Three-Component Pricing Model

```
┌─────────────────────────────────────────────────────────────┐
│ PRICING BREAKDOWN                                            │
└─────────────────────────────────────────────────────────────┘

Input:
  - Voucher Price: 50,000 IDR
  - App Fee %: 3% (from AppSettings)
  - Gas Fee: 5,000 IDR (from active FeeSetting)
  - WEALTH Price: 250.50 IDR per token (real-time)

Calculation:
  1. Base Price: 50,000 IDR
  2. App Fee: 50,000 × 3% = 1,500 IDR
  3. Gas Fee: 5,000 IDR (fixed)
  ────────────────────────────────
  4. Total IDR: 56,500 IDR

  5. Convert to WEALTH:
     WEALTH Amount = 56,500 / 250.50 = 225.549 WEALTH
     App Fee Amount = 1,500 / 250.50 = 5.988 WEALTH
     Gas Fee Amount = 5,000 / 250.50 = 19.960 WEALTH

Storage (Redemption record):
  - wealthAmount: 225.549000000000000000 (Decimal 36,18)
  - appFeeAmount: 5.988000000000000000
  - gasFeeAmount: 19.960000000000000000
  - priceIdrAtRedeem: 50000
  - wealthPriceIdrAtRedeem: 250.5000
```

### WEALTH Token Details

- **Token Name:** $WEALTH / Wealth Crypto
- **Blockchain:** Ethereum Mainnet
- **Listings:**
  - CoinMarketCap: https://coinmarketcap.com/currencies/wealth-crypto/
  - Indodax (Indonesian Exchange)
- **Price API:** CoinMarketCap API
  ```
  GET https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest
    ?slug=wealth-crypto
    &convert=IDR
  ```

### Transaction Confirmation Flow

```
┌─────────────────────────────────────────────────────────────┐
│ STEP 1: User Initiates Payment                              │
└─────────────────────────────────────────────────────────────┘

User signs blockchain transaction:
  - From: User's embedded wallet (0xUSER...)
  - To: Treasury wallet (0xTREAS...)
  - Contract: WEALTH token (0xWEALTH...)
  - Amount: 225.549 WEALTH
  ↓
Transaction broadcast to Ethereum network
  ↓
TxHash returned: "0xaabbccdd..."


┌─────────────────────────────────────────────────────────────┐
│ STEP 2: TxHash Submission                                   │
└─────────────────────────────────────────────────────────────┘

User submits txHash to backend
  ↓
PATCH /api/redemptions/:id/submit-tx
  Body: { txHash: "0xaabbccdd..." }
  ↓
Backend stores txHash in redemption record
  ↓
Redemption status remains: 'pending'


┌─────────────────────────────────────────────────────────────┐
│ STEP 3: Alchemy Webhook (Async, 1-5 minutes)                │
└─────────────────────────────────────────────────────────────┘

Alchemy monitors WEALTH token contract
  ↓
Transaction confirmed on-chain (12 confirmations)
  ↓
Alchemy sends webhook:
  POST /api/webhook/alchemy
  Body: {
    event: {
      activity: [{
        hash: "0xaabbccdd...",
        category: "token",
        typeTraceAddress: "CALL",
        fromAddress: "0xUSER...",
        toAddress: "0xTREAS...",
        value: "225.549000000000000000"
      }]
    }
  }
  ↓
Backend processes webhook:
  1. Verify signature (HMAC-SHA256)
  2. Extract txHash from activity
  3. Call confirmRedemption(txHash)


┌─────────────────────────────────────────────────────────────┐
│ STEP 4: Redemption Confirmation                             │
└─────────────────────────────────────────────────────────────┘

confirmRedemption(txHash):
  1. Find redemption: WHERE txHash = "0xaabbccdd..." AND status = 'pending'
  2. Atomic transaction:
     a. Update redemption:
        - status: 'pending' → 'confirmed'
        - confirmedAt: NOW()
     b. Increment voucher.usedStock
     c. Create Transaction record:
        - transactionHash: "0xaabbccdd..."
        - amount: "225.549"
        - status: "confirmed"
        - type: "redeem"
  ↓
User's redemption now confirmed
QR codes remain 'assigned' (ready to scan at merchant)


┌─────────────────────────────────────────────────────────────┐
│ FAILURE SCENARIO: Transaction Fails                         │
└─────────────────────────────────────────────────────────────┘

Webhook receives failure event
  ↓
failRedemption(txHash):
  1. Find redemption + QR codes
  2. Delete QR images from R2 (best-effort)
  3. Recycle QR codes:
     - status: 'assigned' → 'available'
     - Clear assignedToUserId, redemptionId, imageUrl
  4. Update redemption:
     - status: 'pending' → 'failed'
  ↓
QR codes returned to available pool
User can attempt redemption again
```

### Fee Management

```
┌─────────────────────────────────────────────────────────────┐
│ APP FEE SETTINGS (Singleton)                                 │
└─────────────────────────────────────────────────────────────┘

GET /api/admin/settings
  Response: {
    id: "singleton",
    appFeePercentage: 3,
    tokenContractAddress: "0xWEALTH...",
    treasuryWalletAddress: "0xTREAS..."
  }

PUT /api/admin/settings (Owner only)
  Body: { appFeePercentage: 5 }
  ↓
New redemptions use 5% app fee
Existing redemptions locked at their rate


┌─────────────────────────────────────────────────────────────┐
│ GAS FEE SETTINGS (Multiple Presets)                         │
└─────────────────────────────────────────────────────────────┘

GET /api/admin/fee-settings
  Response: [
    { id: "1", label: "Low", amountIdr: 3000, isActive: false },
    { id: "2", label: "Standard", amountIdr: 5000, isActive: true },
    { id: "3", label: "High", amountIdr: 10000, isActive: false }
  ]

POST /api/admin/fee-settings/:id/activate (Owner only)
  ↓
Atomic update:
  - Set all fees: isActive = false
  - Set target fee: isActive = true
  ↓
New redemptions use newly activated fee
```

---

## Authentication & Authorization

### User Authentication (Privy)

**Flow:**
1. User signs in with Privy (email, wallet, or social)
2. Privy creates embedded wallet
3. Frontend receives Privy auth token
4. Frontend calls `POST /api/auth/user-sync` with token
5. Backend verifies token with Privy API
6. Backend creates/updates User record
7. Subsequent requests include Privy token in header

**Middleware:** `requireUser`
- Validates Privy token
- Queries User by `privyUserId`
- Sets `c.set("userAuth", { userId, email })`

### Admin Authentication (JWT)

**Flow:**
1. Admin logs in: `POST /api/auth/login`
2. Backend verifies email + password (bcrypt)
3. Backend generates JWT (HS256, 24h expiry)
4. Payload: `{ id, email, role, merchantId }`
5. Frontend stores JWT
6. Subsequent requests include JWT in header

**Middleware:** `requireAdmin`
- Validates JWT signature + expiration
- Queries Admin by `id` (instant revocation check)
- Checks `isActive = true`
- Sets `c.set("adminAuth", { adminId, role, merchantId })`

**Role-Based Middleware:**
- `requireManager`: Checks role = `owner` | `manager`
- `requireOwner`: Checks role = `owner`

### Rate Limiting

| Endpoint | Limit | Window | Scope |
|----------|-------|--------|-------|
| POST /api/auth/login | 5 attempts | 15 min | Per email |
| POST /api/auth/set-password | 3 attempts | 15 min | Per email |
| POST /api/auth/user-sync | 10 requests | 1 min | Per IP |
| POST /api/admin/qr-codes/scan | 60 scans | 1 min | Per admin |

---

## Analytics & Reporting

### Available Metrics

**Owner/Manager (System-Wide):**
- Total merchants, vouchers, users
- Confirmed redemptions count
- Total WEALTH volume redeemed
- Average WEALTH per redemption
- Total value in IDR
- Recent activity feed
- Redemptions over time (daily/monthly/yearly)
- WEALTH volume over time
- Merchant category distribution
- Top merchants by redemption count
- Top vouchers by redemption count

**Admin (Merchant-Scoped):**
- Analytics **hidden** in backoffice UI
- If shown: filtered by `merchantId`

### Caching Strategy

- **Technology:** Node-cache (in-memory)
- **TTL:** 5 minutes
- **Cache Keys:** Format `summary-stats:{merchantId?}`
- **Invalidation:** Manual only (no automatic)
- **Benefits:** Reduces DB load, fast dashboard rendering

### Example API Call

```
GET /api/admin/analytics/summary?merchantId=merchant-uuid
  Response: {
    totalVouchers: 50,
    totalRedemptions: 234,
    confirmedRedemptions: 220,
    totalWealthVolume: "12500.450",
    avgWealthPerRedeem: "56.82",
    totalValueIdr: 5000000
  }

GET /api/admin/analytics/redemptions-over-time?period=monthly
  Response: {
    data: [
      { label: "2026-01", count: 50 },
      { label: "2026-02", count: 75 },
      { label: "2026-03", count: 90 },
      { label: "2026-04", count: 19 }
    ]
  }
```

---

## API Reference

### Public Endpoints (No Auth)

```
GET  /api/health
GET  /api/merchants
GET  /api/merchants/:id
GET  /api/vouchers
GET  /api/vouchers/:id
GET  /api/categories
GET  /api/categories/:id
GET  /api/price/wealth
```

### User Endpoints (Privy Auth)

```
POST /api/auth/user-sync
POST /api/vouchers/:id/redeem
PATCH /api/redemptions/:id/submit-tx
GET  /api/redemptions
GET  /api/redemptions/:id
GET  /api/transactions
```

### Admin Endpoints (JWT Auth)

**Auth:**
```
POST /api/auth/login
POST /api/auth/set-password
GET  /api/auth/me
```

**Merchants:**
```
GET    /api/admin/merchants         (Any admin)
POST   /api/admin/merchants         (Manager+)
PUT    /api/admin/merchants/:id     (Manager+)
DELETE /api/admin/merchants/:id     (Owner)
```

**Vouchers:**
```
GET    /api/admin/vouchers           (Any admin)
GET    /api/admin/vouchers/:id       (Any admin)
POST   /api/admin/vouchers           (Any admin)
PUT    /api/admin/vouchers/:id       (Any admin)
DELETE /api/admin/vouchers/:id       (Owner)
```

**QR Codes:**
```
GET  /api/admin/qr-codes             (Any admin)
POST /api/admin/qr-codes             (Any admin - manual creation)
POST /api/admin/qr-codes/scan        (Any admin - rate limited)
```

**Admins:**
```
GET    /api/admin/admins             (Owner)
POST   /api/admin/admins             (Owner)
PUT    /api/admin/admins/:id         (Owner)
DELETE /api/admin/admins/:id         (Owner)
```

**Analytics:**
```
GET /api/admin/analytics/summary
GET /api/admin/analytics/recent-activity
GET /api/admin/analytics/redemptions-over-time
GET /api/admin/analytics/wealth-volume
GET /api/admin/analytics/merchant-categories
GET /api/admin/analytics/top-merchants
GET /api/admin/analytics/top-vouchers
GET /api/admin/analytics/treasury-balance
```

**Settings:**
```
GET /api/admin/settings               (Owner)
PUT /api/admin/settings               (Owner)
```

**Fee Settings:**
```
GET    /api/admin/fee-settings        (Any admin)
POST   /api/admin/fee-settings        (Manager+)
PUT    /api/admin/fee-settings/:id    (Manager+)
POST   /api/admin/fee-settings/:id/activate (Owner)
DELETE /api/admin/fee-settings/:id    (Owner)
```

**Upload:**
```
POST /api/admin/upload                (Any admin)
```

### Webhook Endpoints

```
POST /api/webhook/alchemy             (No auth - signature verified)
```

---

## Frontend Integration Guide

### App (React) - User Flow

#### 1. **Authentication Setup**

```typescript
// src/lib/privy.ts
import { PrivyProvider } from '@privy-io/react-auth';

export function AppProviders({ children }) {
  return (
    <PrivyProvider
      appId={import.meta.env.VITE_PRIVY_APP_ID}
      config={{
        loginMethods: ['email', 'wallet'],
        appearance: {
          theme: 'light',
          accentColor: '#676FFF',
        },
        embeddedWallets: {
          createOnLogin: 'users-without-wallets',
        },
      }}
    >
      {children}
    </PrivyProvider>
  );
}
```

#### 2. **User Sync Hook**

```typescript
// src/hooks/useUserSync.ts
import { usePrivy } from '@privy-io/react-auth';
import { useEffect } from 'react';

export function useUserSync() {
  const { user, getAccessToken, authenticated } = usePrivy();

  useEffect(() => {
    if (authenticated && user) {
      syncUser();
    }
  }, [authenticated, user]);

  async function syncUser() {
    const token = await getAccessToken();

    const response = await fetch(`${API_URL}/api/auth/user-sync`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
      },
    });

    const data = await response.json();
    console.log('User synced:', data.user);
  }
}
```

#### 3. **Voucher Listing**

```typescript
// src/pages/Vouchers.tsx
export function VouchersPage() {
  const [vouchers, setVouchers] = useState([]);

  useEffect(() => {
    fetchVouchers();
  }, []);

  async function fetchVouchers() {
    const response = await fetch(`${API_URL}/api/vouchers?page=1&limit=20`);
    const data = await response.json();
    setVouchers(data.vouchers);
  }

  return (
    <div className="grid grid-cols-2 gap-4">
      {vouchers.map((voucher) => (
        <VoucherCard
          key={voucher.id}
          voucher={voucher}
          available={voucher.availableStock}
          total={voucher.totalStock}
          isAvailable={voucher.isAvailable}
        />
      ))}
    </div>
  );
}
```

#### 4. **Redemption Flow**

```typescript
// src/hooks/useRedemption.ts
import { usePrivy } from '@privy-io/react-auth';
import { v4 as uuidv4 } from 'uuid';

export function useRedemption() {
  const { getAccessToken, sendTransaction } = usePrivy();

  async function redeemVoucher(voucherId: string) {
    // Step 1: Get current WEALTH price
    const priceRes = await fetch(`${API_URL}/api/price/wealth`);
    const { priceIdr: wealthPriceIdr } = await priceRes.json();

    // Step 2: Initiate redemption
    const token = await getAccessToken();
    const idempotencyKey = uuidv4();

    const redeemRes = await fetch(`${API_URL}/api/vouchers/${voucherId}/redeem`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ idempotencyKey, wealthPriceIdr }),
    });

    const { redemption, qrCodes, txDetails } = await redeemRes.json();

    // Step 3: Send blockchain transaction
    const txHash = await sendTransaction({
      to: txDetails.treasuryWalletAddress,
      value: 0, // ERC-20 transfer (not ETH)
      data: encodeERC20Transfer(
        txDetails.tokenContractAddress,
        txDetails.treasuryWalletAddress,
        txDetails.wealthAmount
      ),
    });

    // Step 4: Submit txHash to backend
    await fetch(`${API_URL}/api/redemptions/${redemption.id}/submit-tx`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ txHash }),
    });

    // Step 5: Poll for confirmation
    return pollRedemptionStatus(redemption.id);
  }

  async function pollRedemptionStatus(redemptionId: string) {
    const token = await getAccessToken();
    let attempts = 0;
    const maxAttempts = 60; // 5 minutes (5s interval)

    while (attempts < maxAttempts) {
      const res = await fetch(`${API_URL}/api/redemptions/${redemptionId}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const { redemption } = await res.json();

      if (redemption.status === 'confirmed') {
        return redemption;
      }

      if (redemption.status === 'failed') {
        throw new Error('Redemption failed');
      }

      await new Promise(resolve => setTimeout(resolve, 5000));
      attempts++;
    }

    throw new Error('Redemption timeout');
  }

  return { redeemVoucher };
}
```

#### 5. **QR Code Display**

```typescript
// src/components/QRCodeDisplay.tsx
export function QRCodeDisplay({ qrCode }: { qrCode: QrCode }) {
  const imageUrl = `${R2_PUBLIC_URL}/${qrCode.imageUrl}`;

  return (
    <div className="qr-card">
      <img src={imageUrl} alt="QR Code" className="qr-image" />
      <p className="qr-token">{qrCode.token}</p>
      <p className="qr-status">Status: {qrCode.status}</p>
    </div>
  );
}
```

---

### Backoffice (Vite) - Admin Flow

#### 1. **Authentication**

```typescript
// src/lib/auth.ts
export async function login(email: string, password: string) {
  const response = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

  if (response.status === 403) {
    const { error } = await response.json();
    if (error === 'PASSWORD_NOT_SET') {
      // Redirect to set password
      window.location.href = `/set-password?email=${email}`;
      return;
    }
  }

  const { token, admin } = await response.json();
  localStorage.setItem('adminToken', token);
  localStorage.setItem('adminRole', admin.role);

  return admin;
}

export function getAuthHeader() {
  const token = localStorage.getItem('adminToken');
  return { 'Authorization': `Bearer ${token}` };
}
```

#### 2. **Voucher Creation**

```typescript
// src/pages/CreateVoucher.tsx
export function CreateVoucherPage() {
  async function handleSubmit(data: VoucherFormData) {
    const response = await fetch(`${API_URL}/api/admin/vouchers`, {
      method: 'POST',
      headers: {
        ...getAuthHeader(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        merchantId: data.merchantId, // Auto-filled for admin role
        title: data.title,
        description: data.description,
        startDate: data.startDate,
        endDate: data.endDate,
        totalStock: data.totalStock,
        priceIdr: data.priceIdr,
        qrPerRedemption: data.qrPerRedemption,
      }),
    });

    const { voucher, qrCodesGenerated } = await response.json();

    toast.success(`Voucher created! ${qrCodesGenerated} QR codes generated.`);
    navigate(`/vouchers/${voucher.id}`);
  }

  return <VoucherForm onSubmit={handleSubmit} />;
}
```

#### 3. **QR Code Scanner**

```typescript
// src/components/QRScanner.tsx
import { Html5QrcodeScanner } from 'html5-qrcode';

export function QRScanner() {
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    if (scanning) {
      const scanner = new Html5QrcodeScanner('qr-reader', {
        fps: 10,
        qrbox: { width: 250, height: 250 },
      });

      scanner.render(onScanSuccess, onScanError);

      return () => scanner.clear();
    }
  }, [scanning]);

  async function onScanSuccess(token: string) {
    setScanning(false);

    const response = await fetch(`${API_URL}/api/admin/qr-codes/scan`, {
      method: 'POST',
      headers: {
        ...getAuthHeader(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ token }),
    });

    if (response.ok) {
      const { voucherId, usedAt } = await response.json();
      toast.success('QR Code verified successfully!');
    } else {
      const { error, message } = await response.json();
      if (error === 'ALREADY_USED') {
        toast.error('This QR code has already been used.');
      } else {
        toast.error(message);
      }
    }
  }

  return (
    <div>
      <button onClick={() => setScanning(true)}>Start Scanning</button>
      {scanning && <div id="qr-reader" />}
    </div>
  );
}
```

#### 4. **Analytics Dashboard (Owner/Manager Only)**

```typescript
// src/pages/Analytics.tsx
export function AnalyticsPage() {
  const role = localStorage.getItem('adminRole');

  if (role === 'admin') {
    return <Navigate to="/vouchers" />; // Hide analytics from admin role
  }

  const [summary, setSummary] = useState(null);

  useEffect(() => {
    fetchSummary();
  }, []);

  async function fetchSummary() {
    const response = await fetch(`${API_URL}/api/admin/analytics/summary`, {
      headers: getAuthHeader(),
    });
    const data = await response.json();
    setSummary(data);
  }

  return (
    <div className="analytics-dashboard">
      <StatCard label="Total Redemptions" value={summary?.totalRedemptions} />
      <StatCard label="WEALTH Volume" value={summary?.totalWealthVolume} />
      <StatCard label="Total Value (IDR)" value={formatIDR(summary?.totalValueIdr)} />

      <RedemptionsChart />
      <TopMerchantsTable />
    </div>
  );
}
```

---

## Error Handling & Edge Cases

### Common Errors

| Error Code | Scenario | Solution |
|------------|----------|----------|
| `VOUCHER_NOT_FOUND` | Voucher ID invalid | Check voucher exists & is active |
| `VOUCHER_EXPIRED` | endDate < now() | Show "Expired" badge to user |
| `INSUFFICIENT_QR_CODES` | Not enough available QRs | Wait for failed redemptions to recycle |
| `ALREADY_USED` | QR scanned twice | Show error: "Already scanned at [time]" |
| `WRONG_MERCHANT` | Admin scans wrong merchant QR | Validate merchant ownership |
| `PASSWORD_NOT_SET` | First-time login | Redirect to /set-password |
| `INVALID_TX_HASH` | TxHash format invalid | Validate: 0x + 64 hex chars |
| `DUPLICATE_TX_HASH` | TxHash already used | Check for duplicate submissions |

### Idempotency Handling

**User Redemption:**
```typescript
// Client generates idempotencyKey (UUID)
const idempotencyKey = uuidv4();

// First call: Creates redemption
POST /api/vouchers/:id/redeem
  Body: { idempotencyKey }
  → Response: { redemption, qrCodes }

// Duplicate call (network retry): Returns existing
POST /api/vouchers/:id/redeem
  Body: { idempotencyKey } // Same key
  → Response: { redemption, qrCodes } // Same redemption
```

**QR Scanning:**
```typescript
// First scan: Success
POST /api/admin/qr-codes/scan
  Body: { token: "abc123" }
  → Response: { success: true, voucherId: "..." }

// Second scan: Error (idempotent)
POST /api/admin/qr-codes/scan
  Body: { token: "abc123" } // Same token
  → Response: { error: "ALREADY_USED", usedAt: "..." }
```

### Race Conditions

**Stock Depletion:**
- Use database row locking (`FOR UPDATE`) during redemption
- Check available QR count atomically
- Fail gracefully if insufficient stock

**Concurrent QR Scans:**
- Use atomic `UPDATE ... WHERE status = 'assigned'`
- Only one scan succeeds (affected rows = 1)
- Subsequent scans fail (affected rows = 0)

### Data Integrity

**Foreign Key Constraints:**
- Cannot delete Voucher with active Redemptions
- Cannot delete Merchant with active Vouchers
- Cascade delete: Voucher → QrCodes (on voucher delete)

**Unique Constraints:**
- `qrCode.token` (globally unique)
- `qrCode.imageHash` (detect duplicate images)
- `user.email`, `admin.email` (unique identifiers)
- `redemption.txHash` (no duplicate transactions)

---

## Appendix: Status Reference

### Redemption Status

| Status | Meaning | Trigger |
|--------|---------|---------|
| `pending` | TX submitted, awaiting confirmation | User submits txHash |
| `confirmed` | TX confirmed on-chain | Alchemy webhook success |
| `failed` | TX failed on-chain | Alchemy webhook failure |

### QR Code Status

| Status | Meaning | Trigger |
|--------|---------|---------|
| `available` | Pre-generated, ready to assign | Voucher creation |
| `assigned` | Assigned to user, pending scan | User redemption |
| `used` | Scanned at merchant | Admin scan |

### Transaction Type

| Type | Meaning |
|------|---------|
| `redeem` | User redeemed voucher with crypto |
| `deposit` | (Future) User deposited funds |
| `withdrawal` | (Future) Merchant withdrew earnings |

---

## Next Steps

### Upcoming Refactor (Phase 1)

> ⚠️ **This documentation reflects the POST-REFACTOR flow**. Current implementation differs (QR generation happens on redemption). See refactor plan for migration details.

**Key Changes:**
1. QR tokens generated at voucher creation (not redemption)
2. Images lazy-loaded on assignment (not pre-generated)
3. Failed redemptions recycle QR codes (not delete)
4. Stock management via available QR count

### Future Enhancements

- [ ] Password reset/update endpoints
- [ ] Webhook signature verification (Alchemy HMAC)
- [ ] CoinMarketCap API integration for real-time $WEALTH price
- [ ] Email notifications (admin invites, redemption confirmations)
- [ ] Multi-language support (i18n)
- [ ] Mobile app (React Native)
- [ ] Advanced analytics (conversion funnels, cohort analysis)
- [ ] Merchant earnings withdrawal flow

---

**Document Version:** 1.0.0
**Generated:** April 13, 2026
**Maintained By:** Backend Team
**Questions?** Contact: tech@wealth-redemption.com
