import { describe, it, expect } from "vitest";
import { assertLocalDatabaseUrl } from "../helpers/assert-local-db.js";

/**
 * Safety net: the guard must REFUSE any non-local database so the destructive
 * integration/e2e suites can never wipe the shared Supabase DEV/PROD data.
 * Pure function → deterministic, no env/file dependence.
 */
describe("assertLocalDatabaseUrl — local-only guard", () => {
  // positive
  it("accepts a localhost URL", () => {
    expect(assertLocalDatabaseUrl("postgresql://localhost:5432/wealth_test")).toContain("localhost");
  });

  it("accepts 127.0.0.1 with credentials", () => {
    expect(
      assertLocalDatabaseUrl("postgresql://postgres:postgres@127.0.0.1:5432/wealth_test"),
    ).toContain("127.0.0.1");
  });

  // negative
  it("REFUSES a Supabase pooler host", () => {
    expect(() =>
      assertLocalDatabaseUrl(
        "postgresql://postgres.ulncvbzreqtrfbkfrjrh:pw@aws-1-ap-northeast-2.pooler.supabase.com:5432/postgres",
      ),
    ).toThrow(/REFUSING/);
  });

  it("REFUSES an arbitrary remote host", () => {
    expect(() => assertLocalDatabaseUrl("postgresql://user:pw@db.example.com:5432/prod")).toThrow(
      /non-local/,
    );
  });

  // edge
  it("throws a helpful error when the URL is undefined", () => {
    expect(() => assertLocalDatabaseUrl(undefined)).toThrow(/No TEST_DATABASE_URL/);
  });

  it("throws on a malformed URL", () => {
    expect(() => assertLocalDatabaseUrl("not-a-url")).toThrow(/Invalid test database URL/);
  });
});
