import "dotenv/config";
import { execSync } from "node:child_process";
import { resolveTestDatabaseUrl } from "./helpers/assert-local-db.js";

export async function setup() {
  // Guarded: throws unless the resolved DB is a local disposable Postgres.
  const databaseUrl = resolveTestDatabaseUrl();

  console.log(`\nSyncing Prisma schema to local test DB (${new URL(databaseUrl).host})...\n`);

  // Use `db push` (not `migrate deploy`): the WP tables live in hand-written
  // manual SQL, not in prisma/migrations, so migrate deploy would leave them out.
  // `db push` converges the test DB to schema.prisma exactly. Safe here because
  // the guard guarantees a local, disposable database. `--url` overrides the
  // datasource URL that Prisma 7 otherwise reads from prisma.config.ts.
  execSync(`npx prisma db push --url "${databaseUrl}" --accept-data-loss`, {
    stdio: "inherit",
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });

  execSync("npx prisma generate", { stdio: "inherit", cwd: process.cwd() });

  console.log("\nLocal test database ready.\n");
}

export async function teardown() {
  console.log("\nTest run complete.\n");
}
