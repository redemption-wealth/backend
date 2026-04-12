import { Hono } from "hono";
import { type AuthEnv } from "../../middleware/auth.js";
import { uploadFile, getPublicUrl } from "../../services/r2.js";
import { randomUUID } from "crypto";
import { fileTypeFromBuffer } from "file-type";

const uploadRoutes = new Hono<AuthEnv>();

/**
 * POST /api/admin/upload/logo
 * Upload merchant logo to R2 (public bucket)
 */
uploadRoutes.post("/logo", async (c) => {
  try {
    // Parse multipart form data
    const body = await c.req.parseBody();
    const file = body["file"];

    if (!file || typeof file === "string") {
      return c.json({ error: "No file provided" }, 400);
    }

    // Validate file size (max 5MB)
    const MAX_SIZE = 5 * 1024 * 1024; // 5MB
    const fileBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(fileBuffer);

    if (buffer.length > MAX_SIZE) {
      return c.json(
        { error: "File too large. Maximum size is 5MB" },
        400
      );
    }

    // Validate file type (must be image)
    const fileType = await fileTypeFromBuffer(buffer);

    if (!fileType || !fileType.mime.startsWith("image/")) {
      return c.json(
        { error: "Invalid file type. Only images are allowed" },
        400
      );
    }

    // Generate unique filename
    const extension = fileType.ext;
    const filename = `${randomUUID()}.${extension}`;
    const key = `logos/${filename}`;

    // Upload to R2 (public bucket)
    const bucket = process.env.R2_LOGO_BUCKET_NAME || "wealth-merchant-logos";

    await uploadFile({
      bucket,
      key,
      body: buffer,
      contentType: fileType.mime,
    });

    // Get public URL
    const url = getPublicUrl(key);

    return c.json({
      url,
      filename,
      size: buffer.length,
      contentType: fileType.mime,
    });
  } catch (error) {
    console.error("[Upload Logo] Error:", error);
    return c.json(
      { error: "Failed to upload logo", details: String(error) },
      500
    );
  }
});

export default uploadRoutes;
