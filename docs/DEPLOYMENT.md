# Deployment Guide

## 🚀 Production Deployment

### Recommended Platforms

1. **Railway.app** (Easiest)
2. **Vercel** (Serverless)
3. **DigitalOcean App Platform**
4. **Render.com**
5. **AWS ECS/Fargate** (Advanced)

---

## Option 1: Railway.app (Recommended)

### 1. Prerequisites

- GitHub repository
- Railway account (free tier available)

### 2. Setup Database

1. Go to Railway Dashboard
2. New Project → Provision PostgreSQL
3. Copy `DATABASE_URL` from Variables tab

### 3. Deploy Application

1. New Project → Deploy from GitHub
2. Connect your repository
3. Add Environment Variables:

```env
DATABASE_URL=<from-railway-postgres>
ADMIN_JWT_SECRET=<generate-secure-random-string-32-chars>
PRIVY_APP_ID=<your-privy-app-id>
PRIVY_APP_SECRET=<your-privy-app-secret>
NODE_ENV=production
```

4. Add Build Command:
```bash
pnpm install && pnpm db:migrate && pnpm build
```

5. Add Start Command:
```bash
pnpm start
```

6. Deploy!

### 4. Run Seed (One-time)

In Railway console:
```bash
pnpm db:seed
```

Your API is live at: `https://your-app.up.railway.app`

---

## Option 2: Vercel (Serverless)

### 1. Install Vercel CLI

```bash
pnpm i -g vercel
```

### 2. Create `vercel.json`

```json
{
  "version": 2,
  "builds": [
    {
      "src": "src/index.ts",
      "use": "@vercel/node"
    }
  ],
  "routes": [
    {
      "src": "/(.*)",
      "dest": "src/index.ts"
    }
  ],
  "env": {
    "DATABASE_URL": "@database_url",
    "ADMIN_JWT_SECRET": "@admin_jwt_secret",
    "PRIVY_APP_ID": "@privy_app_id",
    "PRIVY_APP_SECRET": "@privy_app_secret"
  }
}
```

### 3. Deploy

```bash
vercel --prod
```

### 4. Set Environment Variables

```bash
vercel env add DATABASE_URL
vercel env add ADMIN_JWT_SECRET
vercel env add PRIVY_APP_ID
vercel env add PRIVY_APP_SECRET
```

**Important:** Use Supabase or Neon for PostgreSQL with Vercel (serverless compatible).

---

## Option 3: DigitalOcean App Platform

### 1. Create App

1. Go to DigitalOcean Console
2. Apps → Create App → GitHub
3. Select repository

### 2. Configure Build

**Build Command:**
```bash
pnpm install && pnpm db:migrate && pnpm build
```

**Run Command:**
```bash
pnpm start
```

### 3. Add Database

1. Add PostgreSQL Managed Database
2. Auto-injected as `DATABASE_URL`

### 4. Add Environment Variables

```env
ADMIN_JWT_SECRET=<generate>
PRIVY_APP_ID=<your-id>
PRIVY_APP_SECRET=<your-secret>
NODE_ENV=production
```

### 5. Deploy

Click "Create Resources"

---

## Option 4: Docker Deployment

### 1. Create `Dockerfile`

```dockerfile
FROM node:18-alpine

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source
COPY . .

# Generate Prisma Client
RUN pnpm prisma generate

# Build
RUN pnpm build

# Expose port
EXPOSE 3000

# Run migrations and start
CMD ["sh", "-c", "pnpm db:migrate && pnpm start"]
```

### 2. Create `docker-compose.yml`

```yaml
version: '3.8'

services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: wealth
      POSTGRES_PASSWORD: wealth123
      POSTGRES_DB: wealth_redemption
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data

  app:
    build: .
    ports:
      - "3000:3000"
    environment:
      DATABASE_URL: postgresql://wealth:wealth123@postgres:5432/wealth_redemption
      ADMIN_JWT_SECRET: your-secure-secret-min-32-chars
      PRIVY_APP_ID: your-privy-app-id
      PRIVY_APP_SECRET: your-privy-app-secret
      NODE_ENV: production
    depends_on:
      - postgres

volumes:
  postgres_data:
```

### 3. Deploy

```bash
docker-compose up -d
```

---

## Environment Variables (Production)

### Required

```env
# Database (PostgreSQL connection string)
DATABASE_URL="postgresql://user:password@host:5432/database"

# Admin JWT Secret (min 32 characters, use crypto.randomBytes(32).toString('hex'))
ADMIN_JWT_SECRET="your-secure-random-secret-min-32-chars-here"

# Privy Authentication
PRIVY_APP_ID="your-privy-app-id"
PRIVY_APP_SECRET="your-privy-app-secret"
```

### Optional

```env
# Server
PORT=3000
NODE_ENV=production

# Alchemy Webhook (for blockchain confirmations)
ALCHEMY_WEBHOOK_SIGNING_KEY="your-alchemy-signing-key"

# CORS (comma-separated origins)
ALLOWED_ORIGINS="https://app.wealth.com,https://admin.wealth.com"
```

---

## Security Checklist

### Before Deployment

- [ ] Generate strong `ADMIN_JWT_SECRET` (32+ chars)
- [ ] Use environment variables for all secrets
- [ ] Enable HTTPS (automatic on most platforms)
- [ ] Set `NODE_ENV=production`
- [ ] Configure CORS allowed origins
- [ ] Use managed PostgreSQL with SSL
- [ ] Set up database backups
- [ ] Enable rate limiting (already implemented)
- [ ] Configure Alchemy webhook signature verification

### After Deployment

- [ ] Test all endpoints with production URL
- [ ] Verify JWT token expiration (24h)
- [ ] Test rate limiting works
- [ ] Check error logs for any issues
- [ ] Set up monitoring (e.g., Sentry)
- [ ] Configure alerts for errors
- [ ] Test webhook integration
- [ ] Seed initial admin account
- [ ] Change default admin password

---

## Database Migration Strategy

### Initial Deployment

```bash
pnpm db:migrate
pnpm db:seed
```

### Updates (with Zero Downtime)

1. **Create migration:**
```bash
pnpm db:migrate -- --name add_new_feature
```

2. **Test locally:**
```bash
pnpm test
```

3. **Deploy:**
- Most platforms run migrations automatically via build command
- Or use Railway's "Run Command" feature

4. **Rollback (if needed):**
```bash
pnpm db:migrate -- --rollback
```

---

## Monitoring & Logs

### Recommended Tools

1. **Application Monitoring:** Sentry
2. **Uptime Monitoring:** UptimeRobot
3. **Logs:** Railway Logs / Vercel Logs / CloudWatch
4. **Database:** Prisma Accelerate or PgAdmin

### Setup Sentry (Optional)

```bash
pnpm add @sentry/node
```

In `src/index.ts`:
```typescript
import * as Sentry from "@sentry/node";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV,
});
```

---

## Performance Optimization

### Database

- [ ] Enable connection pooling (Prisma default)
- [ ] Add database indexes for frequent queries
- [ ] Use `DATABASE_URL` with connection pool (e.g., Supabase pooler)
- [ ] Consider read replicas for high traffic

### API

- [ ] Enable gzip compression (Hono default)
- [ ] Cache GET responses for merchants/vouchers (60s)
- [ ] Use CDN for static assets
- [ ] Consider Redis for session/cache (if needed)

### Code

- [ ] Build is optimized (`pnpm build`)
- [ ] TypeScript compiled to JavaScript
- [ ] No source maps in production (set in tsconfig)

---

## Backup Strategy

### Database Backups

**Railway/DigitalOcean:** Automatic daily backups (paid plans)

**Manual Backup:**
```bash
pg_dump $DATABASE_URL > backup-$(date +%Y%m%d).sql
```

**Restore:**
```bash
psql $DATABASE_URL < backup-20260412.sql
```

### Application Backup

- Code: GitHub (version controlled)
- Config: Environment variables documented
- Data: Database backups

---

## Scaling Considerations

### Vertical Scaling (Increase Resources)

1. Upgrade database plan (more RAM/CPU)
2. Upgrade app instance size

### Horizontal Scaling (Add Instances)

1. Use load balancer (most platforms provide)
2. Ensure stateless app (no session in memory)
3. Use connection pooling for database
4. Consider Redis for shared cache

---

## Health Check

Add this endpoint to verify deployment:

```typescript
app.get("/health", (c) => {
  return c.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version,
  });
});
```

Test:
```bash
curl https://your-api.com/health
```

---

## Troubleshooting

### App Won't Start

1. Check logs for errors
2. Verify all environment variables set
3. Check database connection (`DATABASE_URL`)
4. Ensure migrations ran (`pnpm db:migrate`)

### Database Connection Errors

1. Check `DATABASE_URL` format
2. Verify database is running
3. Check network/firewall rules
4. Enable SSL if required (add `?sslmode=require`)

### 502 Bad Gateway

1. App crashed - check logs
2. Port mismatch - check `PORT` env var
3. Build failed - check build logs

### Slow Performance

1. Check database query performance (Prisma logs)
2. Add database indexes
3. Enable caching
4. Scale up resources

---

## Post-Deployment

### 1. Test API

Use Postman/Insomnia to test all endpoints.

### 2. Create First Admin

```bash
# If seed didn't run
POST /api/auth/login
{
  "email": "owner@wealth.com",
  "password": "owner123"
}
```

Then change password immediately!

### 3. Configure Webhook

In Alchemy dashboard:
- Add webhook URL: `https://your-api.com/api/webhook/alchemy`
- Add signing key to environment variables

### 4. Update Front-end

Update API base URL in app and back-office:
```env
NEXT_PUBLIC_API_URL=https://your-api.com/api
```

---

## Support

For deployment issues:
- Check platform-specific docs
- Review logs carefully
- Test locally first
- Contact support@example.com

---

**Ready to Deploy!** 🚀
