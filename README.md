# WEALTH Redemption Backend

> **Production-ready** backend API for WEALTH token redemption system with comprehensive test coverage, security hardening, and full documentation.

[![Tests](https://img.shields.io/badge/tests-278%20passing-brightgreen)]()
[![Coverage](https://img.shields.io/badge/coverage-80%25+-brightgreen)]()
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0-blue)]()
[![Hono](https://img.shields.io/badge/Hono-4.7-orange)]()
[![Prisma](https://img.shields.io/badge/Prisma-7.7-2D3748)]()

---

## 📋 Table of Contents

- [Features](#-features)
- [Quick Start](#-quick-start)
- [Documentation](#-documentation)
- [API Endpoints](#-api-endpoints)
- [Testing](#-testing)
- [Deployment](#-deployment)
- [Tech Stack](#-tech-stack)
- [Project Status](#-project-status)

---

## ✨ Features

### 🔐 Security First
- ✅ Better Auth session authentication for admins (7-day expiration, bearer tokens)
- ✅ Privy integration for user authentication
- ✅ Role-based access control (Owner/Manager/Admin)
- ✅ Rate limiting on auth endpoints
- ✅ Input validation with Zod schemas
- ✅ SQL injection & XSS protection
- ✅ Webhook signature verification

### 💰 Business Features
- ✅ Multi-merchant support with categories
- ✅ Voucher management (stock, dates, pricing)
- ✅ Multi-QR redemption (1 or 2 QR per voucher)
- ✅ 3-component pricing (base + app fee + gas fee)
- ✅ Real-time $WEALTH price from CoinMarketCap (USD/IDR via open.er-api.com)
- ✅ Gas fee configuration (hot-swappable)
- ✅ Blockchain transaction tracking
- ✅ Idempotent redemptions

### 👨‍💼 Admin Back-office
- ✅ Full CRUD for merchants, vouchers, QR codes
- ✅ User management (owner-only)
- ✅ Analytics dashboard
- ✅ App settings configuration
- ✅ Fee management
- ✅ First-login password flow

### 🧪 Quality Assurance
- ✅ **278 tests** (100% passing)
- ✅ 80%+ code coverage
- ✅ Unit, integration, and E2E tests
- ✅ Testcontainers for integration tests
- ✅ CI-ready test suite

---

## 🚀 Quick Start

### Prerequisites

- Node.js 18+
- PostgreSQL 14+
- pnpm (or npm)

### Installation

```bash
# Clone repository
git clone <repo-url>
cd backend

# Install dependencies
pnpm install

# Setup environment
cp .env.example .env
# Edit .env with your credentials

# Run migrations & seed
pnpm db:migrate
pnpm db:seed

# Start development server
pnpm dev
```

Server running at `http://localhost:3001` 🎉

**Default Admin (seeded):**
- Email: `owner@wealthcrypto.fund` (override with `INITIAL_OWNER_EMAIL`)
- Password: _not seeded_ — the owner account is created with a NULL password and must set one via the first-login setup-token flow.

⚠️ **The first login issues a one-time setup token to create the password.**

---

## 📚 Documentation

| Document | Description |
|----------|-------------|
| [Architecture Overview](./docs/ARCHITECTURE.md) | System design, security model, scaling |

---

## 🔌 API Endpoints

### Public Routes (App Users)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/merchants` | List active merchants |
| `GET` | `/api/merchants/:id` | Get merchant details |
| `GET` | `/api/vouchers` | List available vouchers |
| `POST` | `/api/vouchers/:id/redeem` | Initiate redemption |
| `GET` | `/api/redemptions` | User's redemptions |
| `PATCH` | `/api/redemptions/:id/submit-tx` | Submit blockchain tx hash |
| `GET` | `/api/price/wealth` | Current $WEALTH price (IDR) |

### Admin Routes (Back-office)

#### Auth

| Method | Endpoint | Description | Role |
|--------|----------|-------------|------|
| `POST` | `/api/auth/sign-in/email` | Admin login | - |
| `POST` | `/api/auth/sign-out` | Sign out current session | Authenticated |
| `POST` | `/api/auth/sign-out-others` | Sign out all other sessions | Authenticated |
| `POST` | `/api/auth/setup-password` | First-login password (setup token) | - |
| `POST` | `/api/auth/change-password` | Change password | Authenticated |
| `GET` | `/api/auth/get-session` | Current session info | Authenticated |

#### Admin (Back-office)

| Method | Endpoint | Description | Role |
|--------|----------|-------------|------|
| `GET` | `/api/admin/merchants` | List merchants | Authenticated |
| `POST` | `/api/admin/merchants` | Create merchant | Manager+ |
| `PUT` | `/api/admin/merchants/:id` | Update merchant | Manager+ |
| `DELETE` | `/api/admin/merchants/:id` | Delete merchant | Manager+ |
| `GET` | `/api/admin/vouchers` | List vouchers | Authenticated |
| `POST` | `/api/admin/vouchers` | Create voucher | Authenticated |
| `PUT` | `/api/admin/vouchers/:id` | Update voucher | Authenticated |
| `GET` | `/api/admin/qr-codes` | List QR codes | Authenticated |
| `GET` | `/api/admin/qr-codes/counts` | QR counts by status | Manager/Admin |
| `POST` | `/api/admin/qr-codes/scan` | Scan/redeem a QR code | Admin role |
| `GET` | `/api/admin/redemptions` | View all redemptions | Owner |
| `GET` | `/api/admin/settings` | Get app settings (incl. fees) | Manager+ |
| `PUT` | `/api/admin/settings` | Update settings/fees | Manager+ |
| `GET` | `/api/admin/analytics/summary` | Dashboard summary stats | Authenticated |
| `GET` | `/api/admin/analytics/redemptions-over-time` | Redemptions trend | Authenticated |
| `GET` | `/api/admin/analytics/merchant-categories` | Category distribution | Authenticated |
| `GET` | `/api/admin/analytics/wealth-volume` | $WEALTH volume trend | Authenticated |
| `GET` | `/api/admin/analytics/top-merchants` | Top merchants | Authenticated |
| `GET` | `/api/admin/analytics/top-vouchers` | Top vouchers | Authenticated |
| `GET` | `/api/admin/analytics/treasury-balance` | On-chain treasury balance | Authenticated |
| `GET` | `/api/admin/admins` | User management | Owner |

---

## 🧪 Testing

### Run Tests

```bash
# All tests
pnpm test              # 278 tests

# By type
pnpm test:unit         # 135 unit tests
pnpm test:integration  # 128 integration tests

# With coverage
pnpm test:coverage     # 80%+ coverage

# Watch mode
pnpm test:watch
```

### Test Structure

```
tests/
├── unit/              # Fast, mocked tests
│   ├── schemas/       # Zod validation tests
│   ├── services/      # Business logic tests
│   └── middleware/    # Auth & rate limit tests
├── integration/       # Real DB tests
│   ├── routes/        # Public API tests
│   └── routes/admin/  # Admin API tests
└── e2e/              # Full flow tests
    ├── redemption-flow.test.ts
    ├── multi-qr-flow.test.ts
    └── security.test.ts
```

### Coverage Report

```bash
pnpm test:coverage

# View HTML report
open coverage/index.html
```

**Current Coverage:** 80%+ (statements, functions, lines)

---

## 🚀 Deployment

### Quick Deploy (Railway)

1. Push to GitHub
2. Connect Railway to repo
3. Add PostgreSQL database
4. Set environment variables
5. Deploy! 🎉

**See [Deployment Guide](./docs/DEPLOYMENT.md) for step-by-step instructions.**

### Supported Platforms

- ✅ Railway.app (Recommended)
- ✅ Vercel (Serverless)
- ✅ DigitalOcean App Platform
- ✅ Render.com
- ✅ Docker / Docker Compose
- ✅ AWS ECS/Fargate

### Environment Variables

```env
# Database (Supabase PostgreSQL)
DATABASE_URL="postgresql://..."

# Server
PORT=3001
CORS_ORIGINS="http://localhost:5173,https://..."

# Better Auth (session secret, min 32 chars)
BETTER_AUTH_SECRET="min-32-chars-change-this-in-production"

# Privy (end-user auth verification)
PRIVY_APP_ID="your-privy-app-id"
PRIVY_APP_SECRET="your-privy-app-secret"

# Blockchain
WEALTH_CONTRACT_ADDRESS="0x..."
DEV_WALLET_ADDRESS="0x..."
ETHEREUM_CHAIN_ID=11155111   # 1 = mainnet, 11155111 = Sepolia
ALCHEMY_RPC_URL="https://eth-sepolia.g.alchemy.com/v2/YOUR_KEY"
ALCHEMY_WEBHOOK_SIGNING_KEY="your-alchemy-webhook-signing-key"

# Price feed (CoinMarketCap for WEALTH/USD, open.er-api.com for USD/IDR)
CMC_API_KEY="your-coinmarketcap-api-key"
WEALTH_CMC_SLUG="wealth-crypto"

# Storage (Cloudflare R2)
R2_ACCOUNT_ID=""
R2_ACCESS_KEY_ID=""
R2_SECRET_ACCESS_KEY=""
R2_QR_BUCKET_NAME="wealth-qr-codes"
R2_LOGO_BUCKET_NAME="wealth-logos"
R2_LOGO_PUBLIC_URL=""

# Cron (Vercel Cron auth)
CRON_SECRET="your-cron-secret"

# Seed
INITIAL_OWNER_EMAIL="owner@wealthcrypto.fund"
```

---

## 🛠 Tech Stack

### Core

- **Runtime:** Node.js 18+
- **Framework:** [Hono 4.7](https://hono.dev) - Ultrafast web framework
- **Language:** TypeScript 6.0
- **Database:** PostgreSQL 14+
- **ORM:** [Prisma 7.7](https://prisma.io)

### Authentication

- **Admin:** [Better Auth](https://better-auth.com) session tokens (bearer, 7-day expiry, bcrypt cost 12)
- **User:** [Privy](https://privy.io) (Web3 auth)

### Validation & Security

- **Schema:** [Zod 4.3](https://zod.dev)
- **Rate Limit:** Custom in-memory limiter
- **Password:** bcrypt

### Testing

- **Framework:** [Vitest 4.1](https://vitest.dev)
- **Containers:** Testcontainers
- **Coverage:** @vitest/coverage-v8

### External APIs

- **Price:** CoinMarketCap (WEALTH/USD) + open.er-api.com (USD/IDR)
- **Blockchain:** Alchemy Webhooks

---

## 📊 Project Status

### Completed ✅

- [x] **Phase 1:** Test Infrastructure & Foundation
- [x] **Phase 2:** Schema Migration & Model Validation
- [x] **Phase 3:** Zod Validation Schemas
- [x] **Phase 4:** Auth, Security & Middleware
- [x] **Phase 5:** Core Business Logic
- [x] **Phase 6:** Public Route Integration Tests
- [x] **Phase 7:** Admin Route Integration Tests
- [x] **Phase 8:** E2E Flows & Security Hardening
- [x] **Documentation:** API, Deployment, Architecture

### Test Results 🎯

```
✅ 278/278 tests passing (100%)
✅ Unit tests: 135 passing
✅ Integration tests: 128 passing
✅ E2E tests: 15 passing
✅ Code coverage: 80%+
✅ TypeScript: No errors
```

### Ready for Production ✅

- ✅ Comprehensive test coverage
- ✅ Security hardening complete
- ✅ Input validation on all endpoints
- ✅ Rate limiting implemented
- ✅ Error handling robust
- ✅ Documentation complete
- ✅ Deployment guides ready

---

## 📝 Scripts

```bash
# Development
pnpm dev              # Start dev server with hot reload
pnpm build            # Build for production
pnpm start            # Start production server

# Database
pnpm db:generate        # Generate Prisma client
pnpm db:migrate         # Run Prisma migrations (dev)
pnpm db:migrate:deploy  # Apply migrations (prod)
pnpm db:seed            # Seed database
pnpm db:studio          # Open Prisma Studio

# Maintenance
pnpm cleanup:stale-pending  # Expire stale pending redemptions

# Testing
pnpm test             # Run all tests
pnpm test:unit        # Unit tests only
pnpm test:integration # Integration tests only
pnpm test:e2e         # E2E tests only
pnpm test:coverage    # With coverage report
pnpm test:watch       # Watch mode
```

---

## 🏗 Architecture Highlights

### 3-Component Pricing

```typescript
totalIdr = priceIdr + appFee + gasFee

where:
  appFee = priceIdr × (appFeePercentage / 100)
  gasFee = activeFeeSettings.amountIdr

wealthAmount = totalIdr / wealthPriceIdr
```

### Multi-QR Redemption

Vouchers support 1 or 2 QR codes per redemption:
- `qrPerRedemption=1` → Single QR code
- `qrPerRedemption=2` → Two QR codes (e.g., dine-in + takeaway)

### Security Model

- **Admin Auth:** Better Auth session tokens (bearer, 7-day expiration; bcrypt cost 12)
- **User Auth:** Privy token verification
- **RBAC:** Three roles — `OWNER`, `MANAGER`, `ADMIN` (guards: `requireOwner`, `requireManager`, `requireManagerOrAdmin`, `requireAdminRole`)
- **Rate Limiting:** Login (per email), set-password (per IP), qr-scan (per admin)
- **Input Validation:** Zod schemas on all routes
- **Data Scoping:** Users see only their own data; `ADMIN` role is scoped to its merchant

**See [Architecture Overview](./docs/ARCHITECTURE.md) for details.**

---

## 📞 Support

- **Documentation:** [./docs](./docs)
- **Issues:** [GitHub Issues](https://github.com/your-repo/issues)
- **Email:** support@example.com

---

**Built with ❤️ for WEALTH Redemption System**

Ready to deploy and integrate with your back-office! 🚀
