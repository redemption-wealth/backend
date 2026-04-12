import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Readable } from "stream";

// Initialize S3 client for Cloudflare R2
const r2Client = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || "",
  },
});

export interface UploadOptions {
  bucket: string;
  key: string;
  body: Buffer | Readable;
  contentType?: string;
}

export interface SignedUrlOptions {
  bucket: string;
  key: string;
  expiresIn?: number; // seconds, default 3600 (1 hour)
}

/**
 * Upload file to R2 bucket
 * Supports both Buffer and Stream uploads
 */
export async function uploadFile(
  options: UploadOptions
): Promise<{ success: boolean; key: string }> {
  try {
    const command = new PutObjectCommand({
      Bucket: options.bucket,
      Key: options.key,
      Body: options.body,
      ContentType: options.contentType || "application/octet-stream",
    });

    await r2Client.send(command);

    console.log(`[R2] Uploaded: ${options.bucket}/${options.key}`);

    return {
      success: true,
      key: options.key,
    };
  } catch (error) {
    console.error(`[R2] Upload failed: ${options.bucket}/${options.key}`, error);
    throw new Error(`Failed to upload file to R2: ${error}`);
  }
}

/**
 * Delete file from R2 bucket
 * Used for cleanup on failed operations
 */
export async function deleteFile(
  bucket: string,
  key: string
): Promise<{ success: boolean }> {
  try {
    const command = new DeleteObjectCommand({
      Bucket: bucket,
      Key: key,
    });

    await r2Client.send(command);

    console.log(`[R2] Deleted: ${bucket}/${key}`);

    return {
      success: true,
    };
  } catch (error) {
    console.error(`[R2] Delete failed: ${bucket}/${key}`, error);
    throw new Error(`Failed to delete file from R2: ${error}`);
  }
}

/**
 * Generate signed URL for private access to R2 objects
 * Used for QR codes (private bucket)
 */
export async function generateSignedUrl(
  options: SignedUrlOptions
): Promise<string> {
  try {
    const command = new GetObjectCommand({
      Bucket: options.bucket,
      Key: options.key,
    });

    const signedUrl = await getSignedUrl(r2Client, command, {
      expiresIn: options.expiresIn || 3600, // Default: 1 hour
    });

    console.log(
      `[R2] Generated signed URL: ${options.bucket}/${options.key} (expires in ${options.expiresIn || 3600}s)`
    );

    return signedUrl;
  } catch (error) {
    console.error(
      `[R2] Signed URL generation failed: ${options.bucket}/${options.key}`,
      error
    );
    throw new Error(`Failed to generate signed URL: ${error}`);
  }
}

/**
 * Get public URL for public buckets (logos)
 */
export function getPublicUrl(key: string): string {
  const publicUrl = process.env.R2_LOGO_PUBLIC_URL;
  if (!publicUrl) {
    throw new Error("R2_LOGO_PUBLIC_URL not configured");
  }
  return `${publicUrl}/${key}`;
}

/**
 * Bulk delete files (used for rollback on failed uploads)
 */
export async function deleteFiles(
  bucket: string,
  keys: string[]
): Promise<{ success: boolean; deletedCount: number; errors: string[] }> {
  const errors: string[] = [];
  let deletedCount = 0;

  for (const key of keys) {
    try {
      await deleteFile(bucket, key);
      deletedCount++;
    } catch (error) {
      errors.push(`${key}: ${error}`);
    }
  }

  return {
    success: errors.length === 0,
    deletedCount,
    errors,
  };
}
