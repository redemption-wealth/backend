import { Hono } from "hono";
import { prisma } from "../../db.js";
import { requireOwner, type AuthEnv } from "../../middleware/auth.js";
import {
  createVoucherSchema,
  updateVoucherSchema,
} from "../../schemas/voucher.js";
import AdmZip from "adm-zip";
import { uploadFile, deleteFiles } from "../../services/r2.js";
import { randomUUID, createHash } from "crypto";
import { fileTypeFromBuffer } from "file-type";
import { tmpdir } from "os";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";

const adminVouchers = new Hono<AuthEnv>();

// GET /api/admin/vouchers — List all vouchers
adminVouchers.get("/", async (c) => {
  const merchantId = c.req.query("merchantId");
  const search = c.req.query("search");
  const page = parseInt(c.req.query("page") ?? "1");
  const limit = parseInt(c.req.query("limit") ?? "20");

  const where = {
    ...(merchantId && { merchantId }),
    ...(search && {
      title: { contains: search, mode: "insensitive" as const },
    }),
  };

  const [vouchersList, total] = await Promise.all([
    prisma.voucher.findMany({
      where,
      include: { merchant: true },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.voucher.count({ where }),
  ]);

  return c.json({
    vouchers: vouchersList,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  });
});

// POST /api/admin/vouchers — Create voucher
adminVouchers.post("/", async (c) => {
  const body = await c.req.json();

  const parsed = createVoucherSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      400
    );
  }

  const { merchantId, title, description, startDate, endDate, totalStock, priceIdr, qrPerRedemption } =
    parsed.data;

  const voucher = await prisma.voucher.create({
    data: {
      merchantId,
      title,
      description,
      startDate: new Date(startDate),
      endDate: new Date(endDate),
      totalStock,
      remainingStock: totalStock,
      priceIdr,
      qrPerRedemption,
    },
  });

  return c.json({ voucher }, 201);
});

// PUT /api/admin/vouchers/:id — Update voucher
adminVouchers.put("/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();

  const parsed = updateVoucherSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      400
    );
  }

  const data = { ...parsed.data } as Record<string, unknown>;
  if (data.startDate) data.startDate = new Date(data.startDate as string);
  if (data.endDate) data.endDate = new Date(data.endDate as string);

  try {
    const voucher = await prisma.voucher.update({ where: { id }, data });
    return c.json({ voucher });
  } catch {
    return c.json({ error: "Voucher not found" }, 404);
  }
});

// DELETE /api/admin/vouchers/:id — Delete voucher (owner only)
adminVouchers.delete("/:id", requireOwner, async (c) => {
  const id = c.req.param("id");
  try {
    await prisma.voucher.delete({ where: { id } });
    return c.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("Foreign key constraint")) {
      return c.json(
        { error: "Cannot delete voucher with existing redemptions" },
        400
      );
    }
    return c.json({ error: "Voucher not found" }, 404);
  }
});

// POST /api/admin/vouchers/:id/upload-qr — Upload QR codes ZIP
adminVouchers.post("/:id/upload-qr", async (c) => {
  const voucherId = c.req.param("id");
  const tempDir = mkdtempSync(join(tmpdir(), "qr-upload-"));
  const uploadedKeys: string[] = [];

  try {
    // 1. Get voucher details
    const voucher = await prisma.voucher.findUnique({
      where: { id: voucherId },
      select: {
        id: true,
        totalStock: true,
        qrPerRedemption: true,
      },
    });

    if (!voucher) {
      return c.json({ error: "Voucher not found" }, 404);
    }

    // Calculate expected QR count
    const expectedCount = voucher.totalStock * voucher.qrPerRedemption;

    // 2. Parse multipart form data
    const body = await c.req.parseBody();
    const file = body["file"];

    if (!file || typeof file === "string") {
      return c.json({ error: "No ZIP file provided" }, 400);
    }

    // 3. Validate file size (max 200MB)
    const MAX_SIZE = 200 * 1024 * 1024;
    const fileBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(fileBuffer);

    if (buffer.length > MAX_SIZE) {
      return c.json({ error: "ZIP file too large. Maximum size is 200MB" }, 400);
    }

    // 4. Extract ZIP
    const zip = new AdmZip(buffer);
    const zipEntries = zip.getEntries();

    // Filter out directories and __MACOSX files
    const imageEntries = zipEntries.filter(
      (entry) => !entry.isDirectory && !entry.entryName.includes("__MACOSX")
    );

    // 5. Validate: Count must match expected
    if (imageEntries.length !== expectedCount) {
      return c.json(
        {
          error: `Expected ${expectedCount} QR code images (${voucher.totalStock} vouchers × ${voucher.qrPerRedemption} QR per redemption), but ZIP contains ${imageEntries.length} images`,
        },
        400
      );
    }

    // 6. Validate: Flat structure only (no subfolders)
    const hasSubfolders = imageEntries.some(
      (entry) => entry.entryName.includes("/")
    );

    if (hasSubfolders) {
      return c.json(
        {
          error: "ZIP must have flat structure (no subfolders). All images should be at root level",
        },
        400
      );
    }

    // 7. Process each image
    const qrRecords: Array<{
      voucherId: string;
      imageUrl: string;
      imageHash: string;
      r2Key: string;
    }> = [];
    const imageHashes = new Set<string>();

    for (const entry of imageEntries) {
      const imageBuffer = entry.getData();

      // Validate: PNG only
      const fileType = await fileTypeFromBuffer(imageBuffer);

      if (!fileType || fileType.ext !== "png") {
        // Cleanup uploaded files
        if (uploadedKeys.length > 0) {
          await deleteFiles(
            process.env.R2_QR_BUCKET_NAME || "wealth-qr-codes",
            uploadedKeys
          );
        }

        return c.json(
          {
            error: `Invalid file type: ${entry.entryName}. Only PNG images are allowed`,
          },
          400
        );
      }

      // Validate: Max 5MB per image
      const MAX_IMAGE_SIZE = 5 * 1024 * 1024;
      if (imageBuffer.length > MAX_IMAGE_SIZE) {
        // Cleanup uploaded files
        if (uploadedKeys.length > 0) {
          await deleteFiles(
            process.env.R2_QR_BUCKET_NAME || "wealth-qr-codes",
            uploadedKeys
          );
        }

        return c.json(
          {
            error: `Image too large: ${entry.entryName}. Maximum size is 5MB per image`,
          },
          400
        );
      }

      // Calculate image hash (for duplicate detection)
      const imageHash = createHash("sha256").update(imageBuffer).digest("hex");

      // Check for duplicates
      if (imageHashes.has(imageHash)) {
        // Cleanup uploaded files
        if (uploadedKeys.length > 0) {
          await deleteFiles(
            process.env.R2_QR_BUCKET_NAME || "wealth-qr-codes",
            uploadedKeys
          );
        }

        return c.json(
          {
            error: `Duplicate image detected: ${entry.entryName}. All QR codes must be unique`,
          },
          400
        );
      }

      imageHashes.add(imageHash);

      // Upload to R2 (private bucket)
      const filename = `${randomUUID()}.png`;
      const key = `qr-codes/${voucherId}/${filename}`;

      try {
        await uploadFile({
          bucket: process.env.R2_QR_BUCKET_NAME || "wealth-qr-codes",
          key,
          body: imageBuffer,
          contentType: "image/png",
        });

        uploadedKeys.push(key);

        // Store R2 key (not full URL, will generate signed URL on-demand)
        qrRecords.push({
          voucherId,
          imageUrl: key, // Store R2 key
          imageHash,
          r2Key: key,
        });
      } catch (error) {
        // Cleanup: Delete all uploaded files
        if (uploadedKeys.length > 0) {
          await deleteFiles(
            process.env.R2_QR_BUCKET_NAME || "wealth-qr-codes",
            uploadedKeys
          );
        }

        throw error;
      }
    }

    // 8. Insert QR records to database (transaction)
    const createdQrCodes = await prisma.$transaction(async (tx) => {
      // Bulk create QR codes
      const qrCodes = await tx.qrCode.createMany({
        data: qrRecords,
      });

      // Fetch created records to return
      const created = await tx.qrCode.findMany({
        where: {
          voucherId,
          imageHash: { in: Array.from(imageHashes) },
        },
        select: {
          id: true,
          imageUrl: true,
          imageHash: true,
          status: true,
          createdAt: true,
        },
      });

      return created;
    });

    // Cleanup temp directory
    rmSync(tempDir, { recursive: true, force: true });

    return c.json({
      success: true,
      count: createdQrCodes.length,
      qrCodes: createdQrCodes,
    });
  } catch (error) {
    // Rollback: Delete all uploaded R2 files
    if (uploadedKeys.length > 0) {
      try {
        await deleteFiles(
          process.env.R2_QR_BUCKET_NAME || "wealth-qr-codes",
          uploadedKeys
        );
      } catch (cleanupError) {
        console.error("[QR Upload] Cleanup failed:", cleanupError);
      }
    }

    // Cleanup temp directory
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch (cleanupError) {
      console.error("[QR Upload] Temp cleanup failed:", cleanupError);
    }

    console.error("[QR Upload] Error:", error);
    return c.json(
      {
        error: "Failed to upload QR codes",
        details: String(error),
      },
      500
    );
  }
});

export default adminVouchers;
