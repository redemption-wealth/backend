# Architecture Overview

## 🏗 System Architecture

### High-Level Architecture

```
┌─────────────────┐         ┌──────────────────┐         ┌─────────────────┐
│   Mobile App    │────────▶│  Backend API     │────────▶│   PostgreSQL    │
│   (User)        │  HTTPS  │  (Hono + TS)     │         │   Database      │
└─────────────────┘         └──────────────────┘         └─────────────────┘
                                     │
                                     │
                                     ▼
                            ┌──────────────────┐
                            │   Privy Auth     │
                            └──────────────────┘
                                     │
                                     ▼
                            ┌──────────────────┐
                            │  CoinGecko API   │
                            └──────────────────┘

┌─────────────────┐         ┌──────────────────┐
│  Back-office    │────────▶│  Backend API     │
│  (Admin)        │  HTTPS  │  (Admin Routes)  │
└─────────────────┘         └──────────────────┘

┌─────────────────┐         ┌──────────────────┐
│   Alchemy       │────────▶│  Webhook         │
│   Webhook       │  HTTPS  │  /api/webhook    │
└─────────────────┘         └──────────────────┘
```

---

## 📦 Project Structure

```
backend/
├── src/
│   ├── app.ts                    # Hono app setup (routes, middleware)
│   ├── index.ts                  # Server entry point
│   ├── db.ts                     # Prisma client
│   ├── middleware/
│   │   ├── auth.ts               # JWT & Privy auth middleware
│   │   └── rate-limit.ts         # Rate limiting middleware
│   ├── routes/
│   │   ├── auth.ts               # Public auth (login, set-password)
│   │   ├── merchants.ts          # Public merchant routes
│   │   ├── vouchers.ts           # Public voucher routes
│   │   ├── redemptions.ts        # User redemption routes
│   │   ├── transactions.ts       # User transaction history
│   │   ├── price.ts              # $WEALTH price endpoint
│   │   ├── webhook.ts            # Alchemy webhook
│   │   └── admin/
│   │       ├── merchants.ts      # Admin merchant CRUD
│   │       ├── vouchers.ts       # Admin voucher CRUD
│   │       ├── qr-codes.ts       # Admin QR management
│   │       ├── redemptions.ts    # Admin redemption view
│   │       ├── admins.ts         # User management (owner-only)
│   │       ├── settings.ts       # App settings
│   │       ├── fee-settings.ts   # Gas fee settings
│   │       └── analytics.ts      # Dashboard stats
│   ├── services/
│   │   ├── redemption.ts         # Core redemption logic
│   │   ├── price.ts              # CoinGecko integration
│   │   ├── pricing.ts            # 3-component pricing calc
│   │   ├── fee-setting.ts        # Fee management
│   │   └── analytics.ts          # Stats aggregation
│   └── schemas/
│       ├── auth.ts               # Zod schemas for auth
│       ├── merchant.ts           # Merchant validation
│       ├── voucher.ts            # Voucher validation
│       ├── admin.ts              # Admin validation
│       ├── fee-setting.ts        # Fee validation
│       ├── settings.ts           # Settings validation
│       └── common.ts             # Shared schemas
├── prisma/
│   ├── schema.prisma             # Database schema
│   ├── seed.ts                   # Seed data
│   └── migrations/               # Migration files
├── tests/
│   ├── unit/                     # Unit tests (mocked)
│   ├── integration/              # Integration tests (real DB)
│   └── e2e/                      # End-to-end tests
└── docs/
    ├── API_DOCUMENTATION.md      # API reference
    ├── QUICK_START.md            # Getting started
    ├── DEPLOYMENT.md             # Deploy guide
    └── ARCHITECTURE.md           # This file
```

---

## 🔧 Technology Stack

### Core

- **Runtime:** Node.js 18+
- **Framework:** Hono 4.7 (Fast, lightweight web framework)
- **Language:** TypeScript 6.0
- **Database:** PostgreSQL 14+
- **ORM:** Prisma 7.7

### Authentication

- **Admin Auth:** JWT (jose library)
- **User Auth:** Privy (Web3 auth)

### Validation

- **Schema Validation:** Zod 4.3
- **Input Sanitization:** Automatic via Zod + Prisma

### Testing

- **Test Framework:** Vitest 4.1
- **Test Containers:** Testcontainers (for integration tests)
- **Coverage:** @vitest/coverage-v8

### External Services

- **Price Feed:** CoinGecko API (free tier)
- **Blockchain Events:** Alchemy Webhooks

---

## 💾 Database Schema

### Core Tables

1. **Admin** - Back-office users
   - JWT-based auth
   - Roles: admin, owner
   - First-login flow support (nullable password)

2. **User** - App users
   - Synced from Privy
   - Email + wallet address

3. **Merchant** - Businesses
   - Categories (kuliner, hiburan, etc.)
   - Active/inactive status

4. **Voucher** - Redeemable offers
   - Stock management
   - Multi-QR support (1 or 2 QR per redemption)
   - Date range validity

5. **QrCode** - Unique redemption codes
   - Status: available → assigned → used
   - Linked to voucher and redemption

6. **Redemption** - User redemption records
   - 3-component pricing (base + app fee + gas fee)
   - Status: pending → confirmed/failed
   - Blockchain tx hash

7. **Transaction** - Ledger entries
   - Type: redeem, refund
   - Linked to redemption

8. **AppSettings** - Singleton config
   - App fee percentage
   - Token contract address
   - Treasury wallet

9. **FeeSetting** - Gas fees
   - Label + amount (IDR)
   - Single active fee

### Key Relations

```
Merchant 1:N Voucher
Voucher 1:N QrCode
Voucher 1:N Redemption
Redemption 1:N QrCode (1 or 2)
Redemption 1:1 Transaction
User 1:N Redemption
Admin 1:N Merchant (createdBy)
```

---

## 🔐 Security Model

### Authentication

**Admin:**
- JWT tokens (HS256 algorithm)
- 24-hour expiration
- Secrets >= 32 characters
- Password hashing: bcrypt (10 rounds)

**User:**
- Privy token verification
- User sync required before API access
- Email + wallet validation

### Authorization

**RBAC (Role-Based Access Control):**

| Route | Admin | Owner |
|-------|-------|-------|
| Public routes | ❌ | ❌ |
| Admin CRUD | ✅ | ✅ |
| User management | ❌ | ✅ |
| Analytics | ❌ | ✅ |
| Settings (write) | ❌ | ✅ |

**User Access Control:**
- Users can only access their own data
- Scoped by `userId` in queries
- 404 returned for unauthorized access (not 403 to avoid info leak)

### Input Validation

**All Routes:**
- Zod schema validation
- Type coercion for query params
- SQL injection protection (Prisma parameterized queries)
- XSS protection (Prisma escaping)

### Rate Limiting

**Protected Endpoints:**
- Login: 5 attempts per email per 15 min
- Set password: 3 attempts per email per 15 min
- User sync: 10 requests per IP per minute

**Implementation:** In-memory Map with TTL

### Data Protection

- Database credentials in environment variables
- JWT secrets in environment variables
- Sensitive fields excluded from responses (passwordHash)
- HTTPS enforced in production

---

## 🔄 Business Logic Flow

### Redemption Flow

```
1. User browses vouchers (GET /api/vouchers)
   ↓
2. User gets current price (GET /api/price/wealth)
   ↓
3. User initiates redemption (POST /api/vouchers/:id/redeem)
   - Validates voucher (active, in stock, not expired)
   - Locks QR codes (1 or 2 based on voucher.qrPerRedemption)
   - Calculates 3-component pricing
   - Creates redemption (status: pending)
   - Assigns QR codes to user
   - Returns redemption + QR codes
   ↓
4. User submits blockchain tx hash (PATCH /api/redemptions/:id/submit-tx)
   - Validates tx hash format
   - Updates redemption.txHash
   ↓
5. Alchemy webhook confirms tx (POST /api/webhook/alchemy)
   - Verifies webhook signature
   - Calls confirmRedemption service
   - Updates redemption (status: confirmed)
   - Decrements voucher stock
   - Creates transaction ledger entry
   ↓
6. Merchant marks QR as used (POST /api/admin/qr-codes/:id/mark-used)
   - QR status: assigned → used
   - Sets usedAt timestamp
```

### 3-Component Pricing

**Formula:**
```
totalIdr = priceIdr + appFee + gasFee

where:
  appFee = priceIdr × (appFeePercentage / 100)
  gasFee = activeFeeSettings.amountIdr

wealthAmount = totalIdr / wealthPriceIdr
```

**Example:**
```
priceIdr: 25,000
appFeePercentage: 3%
gasFeeIdr: 5,000
wealthPriceIdr: 850

appFee = 25,000 × 0.03 = 750
totalIdr = 25,000 + 750 + 5,000 = 30,750
wealthAmount = 30,750 / 850 = 36.176 WEALTH
```

---

## 🧪 Testing Strategy

### Test Pyramid

```
        ╱─────╲
       ╱  E2E  ╲        15 tests (Full user flows)
      ╱─────────╲
     ╱Integration╲      128 tests (API + DB)
    ╱─────────────╲
   ╱     Unit      ╲    135 tests (Business logic)
  ╱─────────────────╲
```

### Test Coverage

**Target:** 80% overall
- Unit tests: 90%+ (services, schemas)
- Integration tests: 80%+ (routes)
- E2E tests: Critical flows only

### Test Types

1. **Unit Tests** (mocked dependencies)
   - Zod schemas
   - Service functions
   - Middleware
   - Pricing calculations

2. **Integration Tests** (real database via Testcontainers)
   - All route handlers
   - Database queries
   - Authentication flow
   - Authorization checks

3. **E2E Tests** (full stack)
   - Complete redemption flow
   - Multi-QR flow
   - First-login admin flow
   - Concurrency scenarios
   - Security hardening

---

## 🚦 Error Handling

### HTTP Status Codes

```typescript
200 OK           // Success
201 Created      // Resource created
400 Bad Request  // Validation error
401 Unauthorized // Missing/invalid auth
403 Forbidden    // Insufficient permissions
404 Not Found    // Resource not found
409 Conflict     // Duplicate/constraint violation
429 Too Many     // Rate limited
500 Server Error // Unexpected error
```

### Error Response Format

```typescript
{
  error: string;           // Human-readable message
  details?: {              // Optional validation details
    fieldErrors: {
      [field]: string[]
    }
  }
}
```

### Error Sources

1. **Validation Errors** (400)
   - Zod schema validation
   - Custom business rules

2. **Authentication Errors** (401)
   - Missing token
   - Invalid/expired token
   - User not synced

3. **Authorization Errors** (403)
   - Insufficient role
   - Resource ownership

4. **Not Found Errors** (404)
   - Resource doesn't exist
   - User doesn't own resource

5. **Conflict Errors** (409)
   - Duplicate email/hash
   - FK constraint violations

6. **Rate Limit Errors** (429)
   - Too many requests

7. **Server Errors** (500)
   - Unexpected exceptions
   - Database connection errors
   - External API failures

---

## 📊 Performance Considerations

### Database Optimization

- **Connection Pooling:** Prisma default (10 connections)
- **Indexes:** Added on foreign keys, unique fields, search fields
- **Query Optimization:** Use `select` to limit fields, `include` for relations
- **Row-Level Locking:** Used in redemption flow for stock management

### Caching Strategy

**Price Cache:**
- $WEALTH price cached for 60 seconds
- Stale cache returned on API failure
- In-memory cache (no Redis needed for MVP)

**Future Improvements:**
- Redis for distributed caching
- Merchant/voucher list caching
- CDN for static assets

### Rate Limiting

- In-memory Map with TTL
- Per-endpoint configuration
- Keyed by: IP or email

---

## 🔍 Monitoring & Observability

### Logging

**Levels:**
- `error` - Unhandled exceptions
- `warn` - Validation failures, rate limits
- `info` - API requests, auth events
- `debug` - Detailed flow (dev only)

**Log Format:**
```typescript
{
  level: "info",
  timestamp: "2026-01-01T12:00:00Z",
  message: "User redeemed voucher",
  userId: "uuid",
  voucherId: "uuid",
  redemptionId: "uuid"
}
```

### Metrics

**Key Metrics:**
- Request rate (req/min)
- Response time (p50, p95, p99)
- Error rate (%)
- Auth success/failure rate
- Redemption success rate
- Database query time

**Tools:**
- Sentry (errors)
- Prisma metrics
- Platform-specific dashboards

---

## 🔄 CI/CD Pipeline

### Build Process

```
1. Code Push to GitHub
   ↓
2. Run Linter (ESLint + TypeScript)
   ↓
3. Run Tests (Unit + Integration + E2E)
   ↓
4. Build (tsc → dist/)
   ↓
5. Run Migrations (Prisma)
   ↓
6. Deploy to Platform
   ↓
7. Health Check
```

### Deployment Strategies

**Blue-Green Deployment:**
- Deploy new version alongside old
- Switch traffic after health check
- Rollback if issues

**Canary Deployment:**
- Route 10% traffic to new version
- Monitor metrics
- Gradually increase to 100%

---

## 🛡 Security Best Practices

### Implemented

✅ Input validation (Zod)
✅ SQL injection prevention (Prisma)
✅ XSS prevention (Prisma escaping)
✅ Rate limiting (brute force protection)
✅ JWT expiration (24h)
✅ Password hashing (bcrypt)
✅ RBAC (admin/owner roles)
✅ User data scoping
✅ HTTPS enforcement
✅ Webhook signature verification
✅ Idempotency keys
✅ Environment variable secrets

### Future Enhancements

- [ ] CSRF protection
- [ ] Request signing
- [ ] IP whitelisting for admin
- [ ] Two-factor authentication
- [ ] Audit logging
- [ ] Data encryption at rest
- [ ] DDoS protection (Cloudflare)

---

## 📈 Scalability

### Current Limits

- Single server instance
- In-memory rate limiting
- Connection pool: 10 connections

### Scaling Path

**Phase 1: Vertical Scaling**
- Increase server resources (CPU/RAM)
- Increase database tier
- Optimize queries

**Phase 2: Horizontal Scaling**
- Multiple app instances behind load balancer
- Redis for shared cache/rate limiting
- Database read replicas

**Phase 3: Microservices**
- Separate redemption service
- Separate auth service
- Message queue for async tasks

---

## 🗺 Roadmap

### Phase 1 (Current)
✅ Core API implementation
✅ Authentication & authorization
✅ Redemption flow
✅ Admin back-office
✅ Testing suite
✅ Documentation

### Phase 2 (Next)
- [ ] WebSocket for real-time updates
- [ ] Admin dashboard with charts
- [ ] Export redemption reports (CSV/PDF)
- [ ] Email notifications
- [ ] SMS notifications

### Phase 3 (Future)
- [ ] Mobile push notifications
- [ ] Loyalty points system
- [ ] Referral program
- [ ] Multi-language support
- [ ] Advanced analytics

---

## 📚 Additional Resources

- [API Documentation](./API_DOCUMENTATION.md)
- [Quick Start Guide](./QUICK_START.md)
- [Deployment Guide](./DEPLOYMENT.md)
- [Prisma Docs](https://www.prisma.io/docs)
- [Hono Docs](https://hono.dev)
- [Vitest Docs](https://vitest.dev)

---

**Questions?** Open an issue or contact support@example.com
