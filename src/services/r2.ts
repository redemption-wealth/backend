import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Readable } from "stream";

// Cloudflare R2 account IDs are 32-character lowercase hex strings.
// Validating early catches typos / missing env that would otherwise surface
// as a cryptic TLS alert 40 (handshake_failure) when the SDK opens its
// connection — the wildcard `*.r2.cloudflarestorage.com` cert refuses any
// host whose SNI doesn't resolve to a real R2 account.
const ACCOUNT_ID_REGEX = /^[0-9a-f]{32}$/;

function readR2Env() {
  const accountId = (process.env.R2_ACCOUNT_ID ?? "").trim();
  const accessKeyId = (process.env.R2_ACCESS_KEY_ID ?? "").trim();
  const secretAccessKey = (process.env.R2_SECRET_ACCESS_KEY ?? "").trim();

  const missing: string[] = [];
  if (!accountId) missing.push("R2_ACCOUNT_ID");
  if (!accessKeyId) missing.push("R2_ACCESS_KEY_ID");
  if (!secretAccessKey) missing.push("R2_SECRET_ACCESS_KEY");
  if (missing.length > 0) {
    throw new Error(
      `R2 env missing: ${missing.join(", ")}. Set them in the deployment environment.`,
    );
  }

  if (!ACCOUNT_ID_REGEX.test(accountId)) {
    throw new Error(
      `R2_ACCOUNT_ID has unexpected format. Cloudflare R2 account IDs are 32 lowercase hex characters; got "${accountId}". Double-check the value in your deployment environment.`,
    );
  }

  return { accountId, accessKeyId, secretAccessKey };
}

let cachedClient: S3Client | null = null;

function getR2Client(): S3Client {
  if (cachedClient) return cachedClient;
  const { accountId, accessKeyId, secretAccessKey } = readR2Env();
  cachedClient = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
  return cachedClient;
}

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

    await getR2Client().send(command);

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

    await getR2Client().send(command);

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

    const signedUrl = await getSignedUrl(getR2Client(), command, {
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
