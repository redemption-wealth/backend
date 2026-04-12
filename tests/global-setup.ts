import "dotenv/config";
import { execSync } from "node:child_process";

export async function setup() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set. Please configure .env file.");
  }

  console.log("\nApplying Prisma migrations to Supabase...\n");

  // Apply Prisma migrations
  execSync("npx prisma migrate deploy", {
    stdio: "inherit",
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });

  // Generate Prisma client
  execSync("npx prisma generate", {
    stdio: "inherit",
    cwd: process.cwd(),
  });

  console.log("\nDatabase ready for testing.\n");
}

export async function teardown() {
  // No container to stop — Supabase persists
  console.log("\nTest run complete.\n");
}
