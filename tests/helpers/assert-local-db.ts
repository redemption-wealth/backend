import { existsSync } from "node:fs";
import { config as loadEnv } from "dotenv";

/**
 * Resolve the database URL for the test suites — and REFUSE to run against any
 * non-local database.
 *
 * Why: the integration/e2e suites `deleteMany()` between tests. The app's real
 * `.env` points `DATABASE_URL` at the shared Supabase DEV project, so running the
 * suites unguarded would wipe real DEV data. The standing rule is zero-delete on
 * DEV/PROD — destructive tests may only ever touch a local, disposable Postgres.
 *
 * Resolution order:
 *   1. `.env.test` (git-ignored, local override) is loaded if present.
 *   2. `TEST_DATABASE_URL` wins over `DATABASE_URL`.
 * The resolved host MUST be localhost/127.0.0.1/::1 and must not be a Supabase
 * host, otherwise we throw before any connection is opened.
 */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", ""]);

/**
 * Pure guard: validate that `url` is a local, disposable Postgres. Throws on a
 * missing/remote/Supabase URL. Kept side-effect-free so it is deterministically
 * unit-testable independent of the environment or the on-disk `.env.test`.
 */
export function assertLocalDatabaseUrl(url: string | undefined): string {
  if (!url) {
    throw new Error(
      "No TEST_DATABASE_URL or DATABASE_URL set for tests. Create backend/.env.test " +
        "with TEST_DATABASE_URL=postgresql://localhost:5432/wealth_test",
    );
  }

  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error(`Invalid test database URL: ${JSON.stringify(url)}`);
  }

  if (/supabase\.com/i.test(url) || !LOCAL_HOSTS.has(host)) {
    throw new Error(
      `REFUSING to run tests against non-local database host "${host}". ` +
        "Integration/e2e tests delete rows between cases — they must only run against a " +
        "local disposable Postgres (e.g. postgresql://localhost:5432/wealth_test). " +
        "Set TEST_DATABASE_URL in backend/.env.test; never point tests at the shared Supabase DB.",
    );
  }

  return url;
}

/** Resolve the test DB URL from `.env.test` → TEST_DATABASE_URL → DATABASE_URL, then guard it. */
export function resolveTestDatabaseUrl(): string {
  if (existsSync(".env.test")) loadEnv({ path: ".env.test" });
  return assertLocalDatabaseUrl(process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL);
}
