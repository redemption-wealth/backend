# 🚀 Deploy ke Vercel - Step by Step

## ✅ Prerequisites Checklist

- [x] Backend code sudah di GitHub
- [x] Punya akun Vercel (gratis)
- [x] Database Supabase sudah jalan
- [x] File `vercel.json` sudah dibuat
- [x] File `api/index.ts` sudah dibuat

---

## 🎯 Method 1: Deploy via Vercel Dashboard (RECOMMENDED)

### Step 1: Import Project

1. **Buka** https://vercel.com/dashboard
2. **Click** "Add New Project"
3. **Import** dari GitHub → Pilih repo `backend`
4. **Configure:**
   - Framework Preset: **Other**
   - Root Directory: `./` (leave as is)
   - Build Command: `pnpm install && pnpm prisma generate && pnpm build`
   - Output Directory: (leave empty)
   - Install Command: `pnpm install`

### Step 2: Set Environment Variables

**PENTING!** Tambahkan semua env vars:

```env
# Database (dari Supabase)
DATABASE_URL=postgresql://postgres:[password]@[host].supabase.co:5432/postgres?pgbouncer=true

# Admin JWT Secret (Generate baru!)
ADMIN_JWT_SECRET=<your-32-character-secret>

# Privy
PRIVY_APP_ID=<your-privy-app-id>
PRIVY_APP_SECRET=<your-privy-app-secret>

# Optional
NODE_ENV=production
ALCHEMY_WEBHOOK_SIGNING_KEY=<your-alchemy-key>
```

**⚠️ IMPORTANT untuk Supabase:**
- Gunakan **connection pooler URL** (port 5432 dengan `?pgbouncer=true`)
- JANGAN pakai direct connection (port 6543)
- Format: `postgresql://postgres:[PASSWORD]@[PROJECT-REF].supabase.co:5432/postgres?pgbouncer=true`

**Generate JWT Secret:**
```bash
# Run di local terminal
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Copy hasilnya ke `ADMIN_JWT_SECRET`

### Step 3: Deploy!

1. **Click** "Deploy"
2. **Wait** 2-3 minutes untuk build
3. **Success!** Domain: `https://your-project.vercel.app`

---

## 🎯 Method 2: Deploy via Vercel CLI

### Step 1: Install Vercel CLI

```bash
npm i -g vercel
```

### Step 2: Login

```bash
vercel login
```

### Step 3: Deploy

```bash
# Dari directory backend
cd /path/to/backend

# Deploy
vercel

# Follow prompts:
# - Set up and deploy? Y
# - Which scope? (pilih account Anda)
# - Link to existing project? N
# - What's your project's name? backend
# - In which directory? ./
# - Override build command? Y → pnpm install && pnpm prisma generate && pnpm build
```

### Step 4: Set Environment Variables

```bash
# Set each variable
vercel env add DATABASE_URL
vercel env add ADMIN_JWT_SECRET
vercel env add PRIVY_APP_ID
vercel env add PRIVY_APP_SECRET
vercel env add NODE_ENV

# Paste values when prompted
```

### Step 5: Deploy Production

```bash
vercel --prod
```

---

## 🔧 Step 4: Run Database Migrations

**IMPORTANT:** Migrations harus dijalankan setelah deploy pertama.

### Option A: Via Vercel CLI

```bash
# SSH ke Vercel environment
vercel env pull .env.production
pnpm prisma migrate deploy
```

### Option B: Via Local dengan Production DB

```bash
# Set production DATABASE_URL temporarily
export DATABASE_URL="your-production-supabase-url"

# Run migrations
pnpm prisma migrate deploy

# Seed (optional)
pnpm prisma db seed

# Unset
unset DATABASE_URL
```

### Option C: Via Supabase SQL Editor

1. Buka Supabase Dashboard
2. SQL Editor
3. Copy isi file `prisma/migrations/[latest]/migration.sql`
4. Paste & Run

---

## ✅ Step 5: Test API

### Test Health Endpoint

```bash
curl https://your-project.vercel.app/health
```

**Expected:**
```json
{
  "status": "ok",
  "timestamp": "2026-04-12T..."
}
```

### Test Admin Login

```bash
curl -X POST https://your-project.vercel.app/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "owner@wealth.com",
    "password": "owner123"
  }'
```

**Expected:**
```json
{
  "token": "eyJhbGc...",
  "admin": {
    "id": "...",
    "email": "owner@wealth.com",
    "role": "owner"
  }
}
```

### Test Public Endpoint

```bash
curl https://your-project.vercel.app/api/merchants
```

**Expected:**
```json
{
  "merchants": [],
  "pagination": { ... }
}
```

---

## 🎨 Step 6: Custom Domain (Optional)

### Via Vercel Dashboard

1. Project Settings → Domains
2. Add Domain: `api.yourapp.com`
3. Add DNS records (Vercel akan kasih instruksi)
4. Wait for DNS propagation (5-10 menit)
5. Done! API available di `https://api.yourapp.com`

---

## 🐛 Troubleshooting

### Error: "Cannot find module 'hono'"

**Fix:**
```json
// vercel.json
{
  "installCommand": "pnpm install --frozen-lockfile"
}
```

### Error: "Prisma Client not generated"

**Fix:**
Add to build command:
```bash
pnpm install && pnpm prisma generate && pnpm build
```

### Error: "Database connection failed"

**Fix:**
1. Check `DATABASE_URL` di Vercel env vars
2. Pastikan pakai **pooler URL** (port 5432 + `?pgbouncer=true`)
3. Vercel serverless butuh connection pooling!

**Correct URL format:**
```
postgresql://postgres:[PASSWORD]@[PROJECT].supabase.co:5432/postgres?pgbouncer=true
```

**Wrong URL format:**
```
postgresql://postgres:[PASSWORD]@[PROJECT].supabase.co:6543/postgres
```

### Error: "Function timeout"

**Fix:**
Vercel free tier: 10s timeout
Vercel Pro: 60s timeout

Kalau butuh lebih lama, upgrade ke Pro atau pakai Railway/DigitalOcean.

### Error: "Module not found: @prisma/client"

**Fix:**
```bash
# Tambahkan postinstall script di package.json
{
  "scripts": {
    "postinstall": "prisma generate"
  }
}
```

### Error: "Cannot read property 'findMany' of undefined"

**Fix:**
Prisma Client belum di-generate. Tambahkan `prisma generate` ke build command.

---

## 📊 Vercel Limits (Free Tier)

| Limit | Value |
|-------|-------|
| Function timeout | 10 seconds |
| Deployments/day | 100 |
| Bandwidth | 100GB/month |
| Functions | Unlimited |
| Team members | 1 (Hobby) |

**Untuk production dengan traffic tinggi:**
- Upgrade ke **Pro** ($20/month)
- Atau pakai **Railway.app** (unlimited)

---

## 🔒 Security Checklist

After deployment:

- [ ] Change default admin password
- [ ] Verify `ADMIN_JWT_SECRET` is strong (32+ chars)
- [ ] Test CORS (tambahkan allowed origins)
- [ ] Set up monitoring (Sentry, LogTail)
- [ ] Configure custom domain with HTTPS
- [ ] Test rate limiting works
- [ ] Verify webhook signature (if using)
- [ ] Set up database backups (Supabase auto-backup)

---

## 📝 Update Your Front-end

Update API URL di app & back-office:

```env
# .env.production (Next.js)
NEXT_PUBLIC_API_URL=https://your-project.vercel.app/api

# Or custom domain
NEXT_PUBLIC_API_URL=https://api.yourapp.com/api
```

---

## 🚀 Continuous Deployment

Vercel automatically:
- ✅ Deploys on every push to `main` branch
- ✅ Creates preview deployments for PRs
- ✅ Runs build checks
- ✅ Updates production

**No extra configuration needed!**

---

## 📞 Need Help?

- **Vercel Docs:** https://vercel.com/docs
- **Hono + Vercel:** https://hono.dev/getting-started/vercel
- **Supabase Pooler:** https://supabase.com/docs/guides/database/connecting-to-postgres#connection-pooler

---

## ✅ Success Checklist

- [ ] Project deployed to Vercel
- [ ] Environment variables set
- [ ] Database migrations run
- [ ] Health check returns OK
- [ ] Admin login works
- [ ] Public endpoints work
- [ ] Custom domain configured (optional)
- [ ] Front-end updated with new API URL
- [ ] Default admin password changed

---

**Selamat! Backend sudah live di Vercel! 🎉**

**Next:** Integrate dengan back-office dan go live!
