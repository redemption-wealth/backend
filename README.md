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
- ✅ JWT authentication for admins (24h expiration)
- ✅ Privy integration for user authentication
- ✅ Role-based access control (Admin/Owner)
- ✅ Rate limiting on auth endpoints
- ✅ Input validation with Zod schemas
- ✅ SQL injection & XSS protection
- ✅ Webhook signature verification

### 💰 Business Features
- ✅ Multi-merchant support with categories
- ✅ Voucher management (stock, dates, pricing)
- ✅ Multi-QR redemption (1 or 2 QR per voucher)
- ✅ 3-component pricing (base + app fee + gas fee)
- ✅ Real-time $WEALTH price from CoinGecko
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

Server running at `http://localhost:3000` 🎉

**Default Admin:**
- Email: `owner@wealth.com`
- Password: `owner123`

⚠️ **Change password immediately after first login!**

---

## 📚 Documentation

| Document | Description |
|----------|-------------|
| [API Documentation](./docs/API_DOCUMENTATION.md) | Complete API reference with examples |
| [Quick Start Guide](./docs/QUICK_START.md) | Get started in 5 minutes |
| [Deployment Guide](./docs/DEPLOYMENT.md) | Deploy to Railway, Vercel, Docker, etc. |
| [Architecture Overview](./docs/ARCHITECTURE.md) | System design, security model, scaling |

---

## 🔌 API Endpoints

### Public Routes (App Users)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/auth/user-sync` | Sync user from Privy |
| `GET` | `/api/merchants` | List active merchants |
| `GET` | `/api/merchants/:id` | Get merchant details |
| `GET` | `/api/vouchers` | List available vouchers |
| `POST` | `/api/vouchers/:id/redeem` | Initiate redemption |
| `GET` | `/api/redemptions` | User's redemptions |
| `PATCH` | `/api/redemptions/:id/submit-tx` | Submit blockchain tx hash |
| `GET` | `/api/transactions` | User's transaction history |
| `GET` | `/api/price/wealth` | Current $WEALTH price (IDR) |

### Admin Routes (Back-office)

| Method | Endpoint | Description | Role |
|--------|----------|-------------|------|
| `POST` | `/api/auth/login` | Admin login | - |
| `POST` | `/api/auth/set-password` | First-login password | - |
| `GET` | `/api/admin/merchants` | List all merchants | Admin |
| `POST` | `/api/admin/merchants` | Create merchant | Admin |
| `PUT` | `/api/admin/merchants/:id` | Update merchant | Admin |
| `DELETE` | `/api/admin/merchants/:id` | Delete merchant | Owner |
| `POST` | `/api/admin/vouchers` | Create voucher | Admin |
| `PUT` | `/api/admin/vouchers/:id` | Update voucher | Admin |
| `POST` | `/api/admin/qr-codes` | Upload QR code | Admin |
| `POST` | `/api/admin/qr-codes/:id/mark-used` | Mark QR as used | Admin |
| `GET` | `/api/admin/redemptions` | View all redemptions | Admin |
| `GET` | `/api/admin/settings` | Get app settings | Admin |
| `PUT` | `/api/admin/settings` | Update settings | Owner |
| `POST` | `/api/admin/fee-settings` | Create gas fee | Admin |
| `POST` | `/api/admin/fee-settings/:id/activate` | Activate fee | Owner |
| `GET` | `/api/admin/analytics/summary` | Dashboard stats | Owner |
| `GET` | `/api/admin/admins` | User management | Owner |

**See [API Documentation](./docs/API_DOCUMENTATION.md) for complete details.**

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
# Required
DATABASE_URL="postgresql://..."
ADMIN_JWT_SECRET="your-secure-32-char-secret"
PRIVY_APP_ID="your-privy-id"
PRIVY_APP_SECRET="your-privy-secret"

# Optional
PORT=3000
NODE_ENV=production
ALCHEMY_WEBHOOK_SIGNING_KEY="..."
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

- **Admin:** JWT (jose)
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

- **Price:** CoinGecko (free tier)
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
pnpm db:migrate       # Run Prisma migrations
pnpm db:seed          # Seed database
pnpm db:studio        # Open Prisma Studio
pnpm db:reset         # Reset database (⚠️ deletes data)

# Testing
pnpm test             # Run all tests
pnpm test:unit        # Unit tests only
pnpm test:integration # Integration tests only
pnpm test:coverage    # With coverage report
pnpm test:watch       # Watch mode

# Code Quality
pnpm lint             # Run ESLint
pnpm typecheck        # Check TypeScript
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

- **Admin Auth:** JWT (HS256, 24h expiration)
- **User Auth:** Privy token verification
- **RBAC:** Admin vs Owner roles
- **Rate Limiting:** Login, set-password, user-sync
- **Input Validation:** Zod schemas on all routes
- **Data Scoping:** Users see only their own data

**See [Architecture Overview](./docs/ARCHITECTURE.md) for details.**

---

## 📞 Support

- **Documentation:** [./docs](./docs)
- **Issues:** [GitHub Issues](https://github.com/your-repo/issues)
- **Email:** support@example.com

---

**Built with ❤️ for WEALTH Redemption System**

Ready to deploy and integrate with your back-office! 🚀
