# QR Generation Refactor Plan

> **Objective:** Shift QR code generation from user redemption time to voucher creation time
> **Status:** Planning
> **Created:** April 13, 2026
> **Engineering Approach:** Compound Engineering (Phased, Tested, Incremental)

---

## Table of Contents

1. [Problem Statement](#problem-statement)
2. [Current vs Target Architecture](#current-vs-target-architecture)
3. [Refactor Strategy](#refactor-strategy)
4. [Phase Breakdown](#phase-breakdown)
5. [Testing Strategy](#testing-strategy)
6. [Rollback Plan](#rollback-plan)
7. [Success Metrics](#success-metrics)

---

## Problem Statement

### Current Flow Issues

**Current Implementation:**
```
Admin creates voucher (totalStock=100)
  ↓
No QR codes generated
  ↓
User redeems voucher
  ↓
System generates 1 QR code on-the-fly:
  - Create token
  - Render PNG image
  - Upload to R2
  - Create DB record
  - Assign to user
  ↓
User receives QR code
```

**Problems:**
1. ❌ **High Redemption Latency:** Image generation blocks user response (2-5s)
2. ❌ **R2 Upload Failures:** Network errors during redemption cause bad UX
3. ❌ **No QR Pool:** Cannot pre-allocate QR codes for inventory management
4. ❌ **Inconsistent Stock:** QR count doesn't match voucher stock
5. ❌ **Failed Redemption Cleanup:** QR codes deleted permanently, not recycled

### Target Architecture Benefits

**New Flow:**
```
Admin creates voucher (totalStock=100)
  ↓
System generates 100 QR tokens immediately:
  - Create token (fast, no image)
  - Create DB records (status='available')
  ↓
QR pool ready for assignment
  ↓
User redeems voucher
  ↓
System assigns existing QR:
  - Find available QR (DB query only)
  - Update status: available → assigned
  - Lazy-load: Generate & upload image (async, can retry)
  ↓
User receives QR code (fast response)
```

**Benefits:**
1. ✅ **Fast Redemption:** 200ms (DB query) vs 2-5s (image generation + upload)
2. ✅ **Resilient:** Image generation errors don't block redemption
3. ✅ **QR Pool Management:** Pre-allocated inventory, clear stock tracking
4. ✅ **Stock Consistency:** QR count = totalStock × qrPerRedemption
5. ✅ **QR Recycling:** Failed redemptions return QRs to available pool

---

## Current vs Target Architecture

### Database Schema Changes

```diff
model Voucher {
  id                String    @id @default(uuid())
  merchantId        String
  title             String
  description       String?
  startDate         DateTime
  endDate           DateTime
  totalStock        Int
- remainingStock    Int       // Manually decremented
+ usedStock         Int       @default(0) // Incremented on confirmation
  priceIdr          Int
  qrPerRedemption   Int       @default(1)
  isActive          Boolean   @default(true)

+ // Computed: availableStock = count(QR where status='available') / qrPerRedemption
+ // Computed: assignedStock = count(QR where status='assigned') / qrPerRedemption

  merchant          Merchant  @relation(...)
  qrCodes           QrCode[]
  redemptions       Redemption[]

  createdAt         DateTime  @default(now())
  updatedAt         DateTime  @updatedAt
}

model QrCode {
  id               String    @id @default(uuid())
  voucherId        String
  redemptionId     String?
  token            String    @unique
- imageUrl         String    // Required on creation
- imageHash        String    // Required on creation
+ imageUrl         String?   // Nullable (lazy-loaded)
+ imageHash        String?   // Nullable (lazy-loaded)
- status           QrCodeStatus @default(assigned) // Always 'assigned' on creation
+ status           QrCodeStatus @default(available) // Pre-generated, ready to assign
  assignedToUserId String?
  assignedAt       DateTime?
  usedAt           DateTime?
  scannedByAdminId String?

  voucher          Voucher   @relation(...)
  redemption       Redemption? @relation(...)
  assignedToUser   User?     @relation(...)
  scannedByAdmin   Admin?    @relation(...)

  createdAt        DateTime  @default(now())
  updatedAt        DateTime  @updatedAt

  @@index([voucherId, status])
+ @@index([status]) // Fast available QR lookup
}

enum QrCodeStatus {
+ available // NEW: Pre-generated, not assigned
  assigned  // Assigned to user, pending scan
  used      // Scanned at merchant
}
```

### Code Architecture Changes

```diff
// src/services/qr.ts

- export async function generateQrCode(redemptionId, index) {
-   const token = generateRandomToken();
-   const qrBuffer = await QRCode.toBuffer(token);
-   const imageHash = hashImage(qrBuffer);
-   const imageUrl = await uploadToR2(qrBuffer);
-   return { token, imageUrl, imageHash };
- }

+ export function generateQrToken(): string {
+   return crypto.randomBytes(16).toString("hex");
+ }
+
+ export async function generateQrTokensForVoucher(
+   prisma: PrismaClient,
+   voucherId: string,
+   count: number
+ ): Promise<void> {
+   const tokens = Array.from({ length: count }, () => generateQrToken());
+
+   await prisma.qrCode.createMany({
+     data: tokens.map((token) => ({
+       voucherId,
+       token,
+       status: "available",
+     })),
+   });
+ }
+
+ export async function generateAndUploadQrImage(
+   voucherId: string,
+   qrCodeId: string,
+   token: string
+ ): Promise<{ imageUrl: string; imageHash: string }> {
+   const qrBuffer = await QRCode.toBuffer(token, { width: 512 });
+   const imageHash = crypto.createHash("sha256").update(qrBuffer).digest("hex");
+
+   const key = `qr-codes/${voucherId}/${qrCodeId}.png`;
+   await uploadToR2(key, qrBuffer);
+
+   return { imageUrl: key, imageHash };
+ }
```

```diff
// src/services/redemption.ts - initiateRedemption()

async function initiateRedemption(...) {
  // ... idempotency check, voucher validation ...

- // Generate QR codes (2-5s latency!)
- const qrCodes = await Promise.all(
-   Array.from({ length: qrPerRedemption }, async (_, i) => {
-     const { token, imageUrl, imageHash } = await generateQrCode(redemption.id, i);
-     return prisma.qrCode.create({
-       data: {
-         voucherId,
-         redemptionId: redemption.id,
-         token,
-         imageUrl,
-         imageHash,
-         status: "assigned",
-         assignedToUserId: userId,
-       },
-     });
-   })
- );

+ // Check available QR count
+ const availableQrCount = await prisma.qrCode.count({
+   where: { voucherId, status: "available" }
+ });
+
+ if (availableQrCount < qrPerRedemption) {
+   throw new HTTPException(400, {
+     message: `Not enough QR codes. Required: ${qrPerRedemption}, Available: ${availableQrCount}`
+   });
+ }
+
+ // Transaction: Create redemption + Assign QR codes
+ const { redemption, qrCodes } = await prisma.$transaction(async (tx) => {
+   const redemption = await tx.redemption.create({ data: {...} });
+
+   const qrCodes = await tx.qrCode.findMany({
+     where: { voucherId, status: "available" },
+     take: qrPerRedemption,
+     orderBy: { createdAt: "asc" }, // FIFO
+   });
+
+   await tx.qrCode.updateMany({
+     where: { id: { in: qrCodes.map(q => q.id) } },
+     data: {
+       status: "assigned",
+       assignedToUserId: userId,
+       redemptionId: redemption.id,
+       assignedAt: new Date(),
+     },
+   });
+
+   return { redemption, qrCodes };
+ });
+
+ // Lazy-load: Generate images (outside transaction, can retry on failure)
+ const qrCodesWithImages = await Promise.all(
+   qrCodes.map(async (qr) => {
+     const { imageUrl, imageHash } = await generateAndUploadQrImage(
+       voucherId,
+       qr.id,
+       qr.token
+     );
+
+     await prisma.qrCode.update({
+       where: { id: qr.id },
+       data: { imageUrl, imageHash },
+     });
+
+     return { ...qr, imageUrl, imageHash };
+   })
+ );

  return { redemption, qrCodes: qrCodesWithImages, txDetails };
}
```

---

## Refactor Strategy

### Compound Engineering Principles

1. **🔬 Research First:** Understand existing patterns via code archaeology
2. **📋 Plan Thoroughly:** Document approach before coding
3. **🔄 Phase Incrementally:** Break into small, testable chunks
4. **✅ Test Continuously:** Run tests after each phase
5. **🔐 Maintain Safety:** Preserve rollback capability at each step
6. **📊 Measure Impact:** Track metrics before/after
7. **📝 Document Changes:** Update docs in parallel with code

### Phased Approach

```
Phase 1: Database Schema & Core Services
├─ 1A: Add QrCodeStatus.available enum
├─ 1B: Add Voucher.usedStock field
├─ 1C: Make QrCode.imageUrl/imageHash nullable
├─ 1D: Create generateQrTokensForVoucher()
├─ 1E: Create generateAndUploadQrImage()
└─ ✅ Commit: "refactor(db): prepare schema for QR pre-generation"

Phase 2: Voucher Creation (Generate QR Tokens)
├─ 2A: Update POST /api/admin/vouchers (generate tokens)
├─ 2B: Update PUT /api/admin/vouchers (adjust token count)
├─ 2C: Add validation for stock decrease
└─ ✅ Commit: "feat(vouchers): generate QR tokens on creation"

Phase 3: Redemption Logic (Assign QR Codes)
├─ 3A: Update initiateRedemption() (assign, not generate)
├─ 3B: Add lazy image generation logic
├─ 3C: Update error handling
└─ ✅ Commit: "refactor(redemption): assign pre-generated QR codes"

Phase 4: Webhook Logic (Recycle QR Codes)
├─ 4A: Update confirmRedemption() (increment usedStock)
├─ 4B: Update failRedemption() (recycle to available)
├─ 4C: Remove QR deletion logic
└─ ✅ Commit: "feat(webhook): recycle failed QR codes"

Phase 5: Stock Management & Display
├─ 5A: Add computed availableStock in voucher list
├─ 5B: Update GET /api/vouchers (show available/total)
├─ 5C: Update admin voucher list (show QR pool status)
└─ ✅ Commit: "feat(stock): display available/used stock"

Phase 6: Cleanup & Documentation
├─ 6A: Remove unused QR generation code
├─ 6B: Update API documentation
├─ 6C: Update BUSINESS_FLOW.md
└─ ✅ Commit: "docs: update for QR pre-generation flow"

Phase 7: Additional Features
├─ 7A: Password reset/update endpoints
├─ 7B: Alchemy webhook signature verification
├─ 7C: CoinMarketCap API integration
└─ ✅ Commit: "feat: add password reset and secure webhook"
```

---

## Phase Breakdown

### Phase 1: Database Schema & Core Services

**Duration:** 1-2 hours

#### 1A. Database Migration

```bash
# Create migration
npx prisma migrate dev --name add-qr-available-status-and-voucher-used-stock

# Migration SQL:
# 1. ALTER TYPE "QrCodeStatus" ADD VALUE 'available';
# 2. ALTER TABLE "Voucher" ADD COLUMN "usedStock" INTEGER NOT NULL DEFAULT 0;
# 3. ALTER TABLE "QrCode" ALTER COLUMN "imageUrl" DROP NOT NULL;
# 4. ALTER TABLE "QrCode" ALTER COLUMN "imageHash" DROP NOT NULL;
# 5. CREATE INDEX "QrCode_status_idx" ON "QrCode"("status");
```

#### 1B. Update Prisma Schema

```prisma
// prisma/schema.prisma
model Voucher {
  // ... existing fields
  usedStock Int @default(0) // NEW
}

model QrCode {
  // ... existing fields
  imageUrl  String?  // Changed: nullable
  imageHash String?  // Changed: nullable
  status    QrCodeStatus @default(available) // Changed: default

  @@index([voucherId, status])
  @@index([status]) // NEW: fast available lookup
}

enum QrCodeStatus {
  available // NEW
  assigned
  used
}
```

#### 1C. Create New Service Functions

**File:** `src/services/qr.ts`

```typescript
export function generateQrToken(): string {
  return crypto.randomBytes(16).toString("hex");
}

export async function generateQrTokensForVoucher(
  prisma: PrismaClient,
  voucherId: string,
  count: number
): Promise<void> {
  const tokens = Array.from({ length: count }, () => generateQrToken());

  await prisma.qrCode.createMany({
    data: tokens.map((token) => ({
      voucherId,
      token,
      status: "available",
    })),
  });
}

export async function generateAndUploadQrImage(
  voucherId: string,
  qrCodeId: string,
  token: string
): Promise<{ imageUrl: string; imageHash: string }> {
  const qrBuffer = await QRCode.toBuffer(token, {
    type: "png",
    width: 512,
    margin: 2,
    errorCorrectionLevel: "H",
  });

  const imageHash = crypto.createHash("sha256").update(qrBuffer).digest("hex");

  const key = `qr-codes/${voucherId}/${qrCodeId}.png`;

  await s3Client.send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME!,
      Key: key,
      Body: qrBuffer,
      ContentType: "image/png",
    })
  );

  return { imageUrl: key, imageHash };
}

export async function deleteQrImage(imageUrl: string): Promise<void> {
  try {
    await s3Client.send(
      new DeleteObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME!,
        Key: imageUrl,
      })
    );
  } catch (err) {
    console.error("[deleteQrImage] Failed:", imageUrl, err);
  }
}
```

#### Phase 1 Testing

```bash
# Run database migration
npm run db:migrate

# Generate Prisma client
npm run db:generate

# Run tests (should pass without changes yet)
npm run test:unit
npm run test:integration

# Build
npm run build

# Commit
git add prisma/ src/services/qr.ts
git commit -m "refactor(db): prepare schema for QR pre-generation

- Add QrCodeStatus.available enum value
- Add Voucher.usedStock field (default 0)
- Make QrCode.imageUrl and imageHash nullable
- Add index on QrCode.status for fast lookups
- Create generateQrTokensForVoucher() service
- Create generateAndUploadQrImage() lazy-load service
- Create deleteQrImage() cleanup service

No breaking changes - schema prepared for next phases

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

### Phase 2: Voucher Creation (Generate QR Tokens)

**Duration:** 1-2 hours

#### 2A. Update Voucher Creation Endpoint

**File:** `src/routes/admin/vouchers.ts`

```typescript
// POST /api/admin/vouchers
app.post("/", requireAdmin, zValidator("json", createVoucherSchema), async (c) => {
  const adminAuth = c.get("adminAuth");
  const body = c.req.valid("json");

  let merchantId = body.merchantId;
  if (adminAuth.role === "admin") {
    merchantId = adminAuth.merchantId!;
  }

  if (!merchantId) {
    throw new HTTPException(400, { message: "merchantId is required" });
  }

  // Calculate total QR codes needed
  const totalQrCodes = body.totalStock * body.qrPerRedemption;

  // Create voucher
  const voucher = await prisma.voucher.create({
    data: {
      merchantId,
      title: body.title,
      description: body.description,
      startDate: new Date(body.startDate),
      endDate: new Date(body.endDate),
      totalStock: body.totalStock,
      usedStock: 0,
      priceIdr: body.priceIdr,
      qrPerRedemption: body.qrPerRedemption,
      isActive: true,
    },
  });

  // Generate QR tokens (no images yet)
  await generateQrTokensForVoucher(prisma, voucher.id, totalQrCodes);

  return c.json({ voucher, qrCodesGenerated: totalQrCodes }, 201);
});
```

#### 2B. Update Voucher Stock Adjustment

```typescript
// PUT /api/admin/vouchers/:id
app.put("/:id", requireManager, zValidator("json", updateVoucherSchema), async (c) => {
  const { id } = c.param();
  const body = c.req.valid("json");
  const adminAuth = c.get("adminAuth");

  const voucher = await prisma.voucher.findUnique({ where: { id } });

  if (!voucher) {
    throw new HTTPException(404, { message: "Voucher not found" });
  }

  // Merchant ownership check
  if (adminAuth.role === "admin" && voucher.merchantId !== adminAuth.merchantId) {
    throw new HTTPException(403, { message: "Access denied" });
  }

  // Handle stock changes
  if (body.totalStock !== undefined && body.totalStock !== voucher.totalStock) {
    const oldStock = voucher.totalStock;
    const newStock = body.totalStock;
    const qrPerRedemption = body.qrPerRedemption ?? voucher.qrPerRedemption;

    const oldQrCount = oldStock * qrPerRedemption;
    const newQrCount = newStock * qrPerRedemption;

    if (newQrCount > oldQrCount) {
      // INCREASE: Generate additional QR codes
      const additionalQr = newQrCount - oldQrCount;
      await generateQrTokensForVoucher(prisma, voucher.id, additionalQr);

    } else if (newQrCount < oldQrCount) {
      // DECREASE: Validate available QR count
      const excessQr = oldQrCount - newQrCount;

      const availableQrCount = await prisma.qrCode.count({
        where: { voucherId: voucher.id, status: "available" }
      });

      if (availableQrCount < excessQr) {
        throw new HTTPException(400, {
          message: `Cannot reduce stock. Only ${availableQrCount} available QR codes. ` +
                   `Need to remove ${excessQr}. Wait for pending redemptions to complete.`
        });
      }

      // Delete excess available QR codes (FIFO)
      const qrsToDelete = await prisma.qrCode.findMany({
        where: { voucherId: voucher.id, status: "available" },
        orderBy: { createdAt: "asc" },
        take: excessQr,
        select: { id: true },
      });

      await prisma.qrCode.deleteMany({
        where: { id: { in: qrsToDelete.map(q => q.id) } }
      });
    }
  }

  // Update voucher
  const updated = await prisma.voucher.update({
    where: { id },
    data: {
      title: body.title,
      description: body.description,
      startDate: body.startDate ? new Date(body.startDate) : undefined,
      endDate: body.endDate ? new Date(body.endDate) : undefined,
      totalStock: body.totalStock,
      priceIdr: body.priceIdr,
      qrPerRedemption: body.qrPerRedemption,
      isActive: body.isActive,
    },
  });

  return c.json({ voucher: updated });
});
```

#### Phase 2 Testing

```bash
# Run integration tests
npm run test:integration

# Manual test: Create voucher
curl -X POST http://localhost:3000/api/admin/vouchers \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "merchantId": "merchant-uuid",
    "title": "Test Voucher",
    "startDate": "2026-01-01",
    "endDate": "2026-12-31",
    "totalStock": 10,
    "priceIdr": 50000,
    "qrPerRedemption": 1
  }'

# Verify: Check QR codes generated
# Expected: 10 QR codes with status='available'

# Build
npm run build

# Commit
git add src/routes/admin/vouchers.ts
git commit -m "feat(vouchers): generate QR tokens on creation

- POST /api/admin/vouchers now generates QR tokens immediately
- Generates totalStock * qrPerRedemption QR codes
- QR codes created with status='available'
- PUT /api/admin/vouchers supports stock increase/decrease
- Stock decrease validates available QR count
- Deletes oldest available QRs (FIFO) when decreasing

Breaking changes: None (backward compatible)
New behavior: QR tokens pre-generated instead of on-demand

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

### Phase 3: Redemption Logic (Assign QR Codes)

**Duration:** 2-3 hours (most complex phase)

#### 3A. Update initiateRedemption()

**File:** `src/services/redemption.ts`

```typescript
export async function initiateRedemption(
  prisma: PrismaClient,
  voucherId: string,
  userId: string,
  idempotencyKey: string,
  wealthPriceIdr: number
) {
  // 1. Check idempotency
  const existing = await prisma.redemption.findFirst({
    where: { userId, idempotencyKey },
    include: { qrCodes: true },
  });

  if (existing) {
    return { redemption: existing, qrCodes: existing.qrCodes };
  }

  // 2. Lock and validate voucher
  const voucher = await prisma.voucher.findUnique({
    where: { id: voucherId },
    include: { merchant: true },
  });

  if (!voucher) {
    throw new HTTPException(404, { message: "Voucher not found" });
  }

  if (!voucher.isActive) {
    throw new HTTPException(400, { message: "Voucher is not active" });
  }

  if (new Date() > voucher.endDate) {
    throw new HTTPException(400, { message: "Voucher has expired" });
  }

  // 3. Check available QR codes
  const availableQrCount = await prisma.qrCode.count({
    where: { voucherId, status: "available" }
  });

  const requiredQr = voucher.qrPerRedemption;

  if (availableQrCount < requiredQr) {
    throw new HTTPException(400, {
      message: `Not enough QR codes available. Required: ${requiredQr}, Available: ${availableQrCount}`
    });
  }

  // 4. Calculate pricing
  const appSettings = await prisma.appSettings.findUnique({
    where: { id: "singleton" }
  });

  const activeFee = await prisma.feeSetting.findFirst({
    where: { isActive: true }
  });

  const appFeePercentage = appSettings?.appFeePercentage ?? 3;
  const gasFeeIdr = activeFee?.amountIdr ?? 0;

  const appFeeIdr = (voucher.priceIdr * appFeePercentage) / 100;
  const totalIdr = voucher.priceIdr + appFeeIdr + gasFeeIdr;

  const wealthAmount = totalIdr / wealthPriceIdr;
  const appFeeAmount = appFeeIdr / wealthPriceIdr;
  const gasFeeAmount = gasFeeIdr / wealthPriceIdr;

  // 5. Transaction: Create redemption + Assign QR codes
  const result = await prisma.$transaction(async (tx) => {
    // Create redemption
    const redemption = await tx.redemption.create({
      data: {
        userId,
        voucherId,
        status: "pending",
        wealthAmount,
        appFeeAmount,
        gasFeeAmount,
        priceIdrAtRedeem: voucher.priceIdr,
        wealthPriceIdrAtRedeem: wealthPriceIdr,
        idempotencyKey,
        qrPerRedemption: requiredQr,
        scannedQrCount: 0,
      },
    });

    // Find available QR codes (FIFO)
    const qrCodes = await tx.qrCode.findMany({
      where: { voucherId, status: "available" },
      take: requiredQr,
      orderBy: { createdAt: "asc" },
    });

    // Assign QR codes to user
    await tx.qrCode.updateMany({
      where: { id: { in: qrCodes.map(qr => qr.id) } },
      data: {
        status: "assigned",
        assignedToUserId: userId,
        redemptionId: redemption.id,
        assignedAt: new Date(),
      },
    });

    return { redemption, qrCodes };
  });

  // 6. Generate QR images (lazy-load, outside transaction)
  const qrCodesWithImages = await Promise.all(
    result.qrCodes.map(async (qr) => {
      try {
        const { imageUrl, imageHash } = await generateAndUploadQrImage(
          voucherId,
          qr.id,
          qr.token
        );

        await prisma.qrCode.update({
          where: { id: qr.id },
          data: { imageUrl, imageHash },
        });

        return { ...qr, imageUrl, imageHash };
      } catch (err) {
        console.error(`[initiateRedemption] Image generation failed for QR ${qr.id}:`, err);
        // Return QR without image (can be retried later)
        return qr;
      }
    })
  );

  // 7. Return redemption data
  const treasuryAddress = appSettings?.treasuryWalletAddress;
  const tokenAddress = appSettings?.tokenContractAddress;

  return {
    redemption: result.redemption,
    qrCodes: qrCodesWithImages,
    txDetails: {
      tokenContractAddress: tokenAddress,
      treasuryWalletAddress: treasuryAddress,
      wealthAmount: wealthAmount.toString(),
    },
  };
}
```

#### Phase 3 Testing

```bash
# Run redemption tests
npm run test:redemption

# Manual test: Redeem voucher
# 1. Create voucher (should have available QRs)
# 2. Redeem voucher (should assign QRs, not generate)
# 3. Check response time (should be <500ms)
# 4. Verify QR status changed: available → assigned

# Build
npm run build

# Commit
git add src/services/redemption.ts
git commit -m "refactor(redemption): assign pre-generated QR codes

- initiateRedemption() now assigns existing QR codes
- Find N available QR codes (FIFO order)
- Atomic transaction: create redemption + assign QRs
- Lazy-load QR images after transaction (async, can retry)
- Image generation errors don't block redemption
- Improved response time: 200-500ms (was 2-5s)

Breaking changes: None
Performance: 80% faster redemption

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

### Phase 4: Webhook Logic (Recycle QR Codes)

**Duration:** 1 hour

#### 4A. Update confirmRedemption()

```typescript
export async function confirmRedemption(
  prisma: PrismaClient,
  txHash: string
) {
  const redemption = await prisma.redemption.findFirst({
    where: { txHash, status: "pending" },
  });

  if (!redemption) return;

  await prisma.$transaction(async (tx) => {
    // Update redemption status
    await tx.redemption.update({
      where: { id: redemption.id },
      data: {
        status: "confirmed",
        confirmedAt: new Date(),
      },
    });

    // Increment voucher usedStock
    await tx.voucher.update({
      where: { id: redemption.voucherId },
      data: { usedStock: { increment: 1 } },
    });

    // Create transaction record
    await tx.transaction.create({
      data: {
        redemptionId: redemption.id,
        transactionHash: txHash,
        amount: redemption.wealthAmount.toString(),
        status: "confirmed",
        type: "redeem",
        fromAddress: "", // TODO: Extract from webhook data
        toAddress: "", // TODO: Extract from webhook data
      },
    });
  });
}
```

#### 4B. Update failRedemption()

```typescript
export async function failRedemption(
  prisma: PrismaClient,
  txHash: string
) {
  const redemption = await prisma.redemption.findFirst({
    where: { txHash, status: "pending" },
    include: { qrCodes: true },
  });

  if (!redemption) return;

  // Delete QR images from R2 (best-effort, non-blocking)
  await Promise.all(
    redemption.qrCodes.map(async (qr) => {
      if (qr.imageUrl) {
        await deleteQrImage(qr.imageUrl);
      }
    })
  );

  // Recycle QR codes: assigned → available
  await prisma.$transaction(async (tx) => {
    await tx.qrCode.updateMany({
      where: { redemptionId: redemption.id },
      data: {
        status: "available",
        assignedToUserId: null,
        redemptionId: null,
        assignedAt: null,
        imageUrl: null,
        imageHash: null,
      },
    });

    await tx.redemption.update({
      where: { id: redemption.id },
      data: { status: "failed" },
    });
  });
}
```

#### Phase 4 Testing

```bash
# Run webhook tests
npm run test:integration -- webhook

# Manual test: Trigger webhook
# 1. Create redemption
# 2. Submit txHash
# 3. Simulate webhook (success): call confirmRedemption()
# 4. Verify: usedStock incremented
# 5. Simulate webhook (failure): call failRedemption()
# 6. Verify: QR codes recycled (status=available)

# Build
npm run build

# Commit
git add src/services/redemption.ts
git commit -m "feat(webhook): recycle failed QR codes

- confirmRedemption() increments voucher.usedStock
- failRedemption() recycles QR codes to available pool
- QR codes no longer deleted permanently
- Recycled QRs cleared: imageUrl, imageHash, assignedAt
- Best-effort R2 image cleanup (non-blocking)

Breaking changes: None
New behavior: Failed redemptions return QRs to pool

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

### Phase 5: Stock Management & Display

**Duration:** 1 hour

#### 5A. Update Voucher List Endpoint

**File:** `src/routes/vouchers.ts`

```typescript
app.get("/", zValidator("query", listVouchersSchema), async (c) => {
  const query = c.req.valid("query");

  const vouchers = await prisma.voucher.findMany({
    where: {
      isActive: true,
      endDate: { gte: new Date() },
      merchantId: query.merchantId,
    },
    include: {
      merchant: { include: { category: true } },
      _count: {
        select: {
          qrCodes: {
            where: { status: "available" }
          }
        }
      }
    },
    orderBy: { createdAt: "desc" },
    take: query.limit,
    skip: (query.page - 1) * query.limit,
  });

  // Calculate stock breakdown
  const vouchersWithStock = vouchers.map((v) => {
    const availableQrCount = v._count.qrCodes;
    const availableStock = Math.floor(availableQrCount / v.qrPerRedemption);

    const assignedQrCount = v.totalStock * v.qrPerRedemption - v.usedStock * v.qrPerRedemption - availableQrCount;
    const assignedStock = Math.floor(assignedQrCount / v.qrPerRedemption);

    return {
      ...v,
      availableStock,   // e.g., 48 (can be redeemed now)
      assignedStock,    // e.g., 2 (pending confirmation)
      usedStock: v.usedStock,  // e.g., 50 (completed)
      totalStock: v.totalStock, // e.g., 100
      isAvailable: availableStock > 0,
    };
  });

  const total = await prisma.voucher.count({
    where: {
      isActive: true,
      endDate: { gte: new Date() },
      merchantId: query.merchantId,
    },
  });

  return c.json({
    vouchers: vouchersWithStock,
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    },
  });
});
```

#### Phase 5 Testing

```bash
# Run voucher list tests
npm run test:integration -- vouchers

# Manual test: List vouchers
curl http://localhost:3000/api/vouchers

# Expected response:
# {
#   "vouchers": [
#     {
#       "id": "...",
#       "title": "Coffee 50% Off",
#       "availableStock": 48,
#       "assignedStock": 2,
#       "usedStock": 50,
#       "totalStock": 100,
#       "isAvailable": true
#     }
#   ]
# }

# Build
npm run build

# Commit
git add src/routes/vouchers.ts src/routes/admin/vouchers.ts
git commit -m "feat(stock): display available/assigned/used stock

- GET /api/vouchers shows stock breakdown
- availableStock: QR codes ready to redeem
- assignedStock: QR codes pending confirmation
- usedStock: completed redemptions
- totalStock: total vouchers created
- isAvailable: true if availableStock > 0

Breaking changes: Response format changed (added fields)

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Testing Strategy

### Test Coverage

```
Unit Tests (tests/unit/)
├─ services/qr.test.ts
│  ├─ generateQrToken() → unique tokens
│  ├─ generateQrTokensForVoucher() → bulk creation
│  └─ generateAndUploadQrImage() → image generation

Integration Tests (tests/integration/)
├─ routes/admin/vouchers.test.ts
│  ├─ POST /api/admin/vouchers → QR tokens generated
│  ├─ PUT /api/admin/vouchers → stock increase/decrease
│  └─ Stock decrease validation
├─ routes/redemptions/
│  ├─ list.test.ts → show available/total stock
│  ├─ get.test.ts → redemption with assigned QRs
│  └─ submit-tx.test.ts → txHash submission
├─ routes/webhook.test.ts
│  ├─ confirmRedemption() → usedStock incremented
│  └─ failRedemption() → QR codes recycled

E2E Tests (tests/e2e/)
├─ redemption-flow.test.ts
│  ├─ Create voucher → verify QR tokens
│  ├─ Redeem voucher → verify QR assignment
│  ├─ Webhook confirm → verify usedStock
│  └─ Webhook fail → verify QR recycling
```

### Regression Tests

**Critical Paths to Test:**
1. ✅ Voucher creation with QR token generation
2. ✅ Voucher stock increase (add QR tokens)
3. ✅ Voucher stock decrease (delete available QRs)
4. ✅ User redemption (assign QRs, not generate)
5. ✅ Idempotent redemption (same idempotencyKey)
6. ✅ Webhook confirmation (usedStock incremented)
7. ✅ Webhook failure (QR recycling)
8. ✅ QR scanning (status: assigned → used)
9. ✅ Voucher listing (available/used stock display)
10. ✅ Multi-QR redemption (qrPerRedemption > 1)

### Performance Tests

**Benchmarks (Before vs After):**

| Operation | Before (Generate) | After (Assign) | Improvement |
|-----------|-------------------|----------------|-------------|
| Create Voucher (100 QR) | 500ms | 2-5s (bulk tokens) | -400% (slower, but async) |
| User Redemption | 2-5s | 200-500ms | +80% (faster) |
| QR Image Generation | Blocking | Async | Non-blocking |
| Failed Redemption | Delete QR | Recycle QR | Reusable |

**Run Benchmarks:**
```bash
# Before refactor
npm run test:perf -- redemption-before

# After refactor
npm run test:perf -- redemption-after

# Compare results
npm run test:perf:compare
```

---

## Rollback Plan

### Rollback Triggers

Rollback if any of these occur:
- ❌ Test failure rate >5%
- ❌ Redemption latency >1s (P95)
- ❌ QR generation failure rate >1%
- ❌ Data integrity issues (orphaned QRs, stock mismatch)
- ❌ Production errors >10 per hour

### Rollback Steps

```bash
# 1. Revert all commits
git revert HEAD~6..HEAD # Revert last 6 commits (phases 1-6)

# 2. Run database migration rollback
npx prisma migrate reset

# 3. Restore previous Prisma schema
git checkout HEAD~7 -- prisma/schema.prisma

# 4. Regenerate Prisma client
npm run db:generate

# 5. Run tests
npm run test:run

# 6. Deploy rollback
npm run build
npm run deploy

# 7. Monitor for 1 hour
# - Check error logs
# - Verify redemption success rate
# - Confirm QR generation works
```

### Rollback Validation

After rollback, verify:
- ✅ Voucher creation works (generates QRs on redemption)
- ✅ User redemption works (generates images on-the-fly)
- ✅ Webhook confirmation works
- ✅ QR scanning works
- ✅ No database errors
- ✅ No missing QR codes

---

## Success Metrics

### Functional Metrics

- ✅ All integration tests pass (100%)
- ✅ All E2E tests pass (100%)
- ✅ QR token generation success rate: 100%
- ✅ QR assignment success rate: >99%
- ✅ Image generation success rate: >95% (lazy-load can retry)
- ✅ Webhook processing success rate: >99%

### Performance Metrics

- ✅ Voucher creation: <3s (bulk token generation)
- ✅ User redemption: <500ms (P95), <1s (P99)
- ✅ QR image generation: <2s per image (async, non-blocking)
- ✅ Webhook processing: <1s

### Business Metrics

- ✅ Stock accuracy: 100% (QR count = totalStock × qrPerRedemption)
- ✅ Failed redemption recovery: 100% (QRs recycled)
- ✅ QR reusability: >0% (recycled QRs assigned to new users)
- ✅ User satisfaction: No increase in redemption errors

---

## Appendix

### Compound Engineering Checklist

Before starting each phase:
- [ ] Read existing code and understand patterns
- [ ] Document current behavior
- [ ] Identify dependencies and side effects
- [ ] Plan rollback strategy
- [ ] Write tests before refactoring (TDD)

During each phase:
- [ ] Make smallest possible change
- [ ] Run tests after each change
- [ ] Commit frequently with clear messages
- [ ] Update documentation in parallel
- [ ] Monitor for regressions

After each phase:
- [ ] Run full test suite
- [ ] Manual smoke testing
- [ ] Performance benchmarking
- [ ] Code review (self or peer)
- [ ] Update BUSINESS_FLOW.md

### Phase Checklist Template

```markdown
## Phase X: [Phase Name]

- [ ] 1. Read current implementation
- [ ] 2. Write failing tests (if needed)
- [ ] 3. Implement changes
- [ ] 4. Run unit tests
- [ ] 5. Run integration tests
- [ ] 6. Run E2E tests
- [ ] 7. Manual testing
- [ ] 8. Performance check
- [ ] 9. Update documentation
- [ ] 10. Commit with clear message
```

---

**Plan Version:** 1.0.0
**Created:** April 13, 2026
**Status:** Ready for Execution
**Estimated Duration:** 8-12 hours (1.5 working days)
**Risk Level:** Medium (breaking schema changes, but phased approach)

---

Ready to start Phase 1? Review this plan and confirm before proceeding! 🚀
