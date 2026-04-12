# Quick Start Guide

## 🚀 Get Started in 5 Minutes

### Prerequisites

- Node.js 18+
- PostgreSQL 14+
- pnpm (or npm)

### 1. Install Dependencies

```bash
pnpm install
```

### 2. Setup Environment

Create `.env` file:

```env
# Database
DATABASE_URL="postgresql://user:password@localhost:5432/wealth_redemption"

# Auth
ADMIN_JWT_SECRET="your-secure-random-secret-min-32-chars"
PRIVY_APP_ID="your-privy-app-id"
PRIVY_APP_SECRET="your-privy-app-secret"

# Optional
PORT=3000
NODE_ENV=development
```

### 3. Run Migrations

```bash
pnpm db:migrate
pnpm db:seed
```

### 4. Start Server

```bash
pnpm dev
```

Server running at `http://localhost:3000`

---

## 📝 Test It Out

### 1. Login as Admin

```bash
POST http://localhost:3000/api/auth/login
Content-Type: application/json

{
  "email": "owner@wealth.com",
  "password": "owner123"
}
```

Response:
```json
{
  "token": "eyJhbGc...",
  "admin": { ... }
}
```

### 2. Create a Merchant

```bash
POST http://localhost:3000/api/admin/merchants
Authorization: Bearer YOUR_TOKEN
Content-Type: application/json

{
  "name": "Test Restaurant",
  "category": "kuliner"
}
```

### 3. Get Public Merchants

```bash
GET http://localhost:3000/api/merchants
```

---

## 🧪 Run Tests

```bash
# All tests
pnpm test

# Unit tests only
pnpm test:unit

# Integration tests only
pnpm test:integration

# With coverage
pnpm test:coverage
```

---

## 📚 Next Steps

1. Read [API Documentation](./API_DOCUMENTATION.md)
2. See [Deployment Guide](./DEPLOYMENT.md)
3. Check [Architecture Overview](./ARCHITECTURE.md)

---

## 🛠 Available Scripts

```bash
pnpm dev          # Start dev server with hot reload
pnpm build        # Build for production
pnpm start        # Start production server
pnpm db:migrate   # Run Prisma migrations
pnpm db:seed      # Seed database
pnpm db:studio    # Open Prisma Studio
pnpm test         # Run all tests
pnpm lint         # Run linter
```

---

## 🐛 Troubleshooting

### Database Connection Error

```bash
# Make sure PostgreSQL is running
pg_ctl -D /usr/local/var/postgres start

# Or with Docker
docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:16
```

### Port Already in Use

```bash
# Change PORT in .env
PORT=3001
```

### Migration Failed

```bash
# Reset database (WARNING: deletes all data)
pnpm db:reset

# Then run migrations again
pnpm db:migrate
```

---

## 📞 Need Help?

- Check [API Documentation](./API_DOCUMENTATION.md)
- Open an issue on GitHub
- Contact: support@example.com
