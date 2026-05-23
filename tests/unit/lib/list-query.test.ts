import { describe, test, expect } from "vitest";
import { parseSort, buildOrderBy } from "@/lib/list-query.js";

function ctx(query: Record<string, string>) {
  return { req: { query: (k: string) => query[k] } };
}

describe("parseSort", () => {
  test("reads sort + dir", () => {
    expect(parseSort(ctx({ sort: "wealth", dir: "asc" }))).toEqual({ sort: "wealth", dir: "asc" });
  });

  test("accepts sortBy/sortOrder aliases", () => {
    expect(parseSort(ctx({ sortBy: "user", sortOrder: "asc" }))).toEqual({ sort: "user", dir: "asc" });
  });

  test("defaults dir to desc and normalizes invalid dir", () => {
    expect(parseSort(ctx({ sort: "user" })).dir).toBe("desc");
    expect(parseSort(ctx({ sort: "user", dir: "sideways" })).dir).toBe("desc");
  });
});

describe("buildOrderBy", () => {
  const map = {
    user: (dir: "asc" | "desc") => ({ userEmail: dir }),
    voucher: (dir: "asc" | "desc") => ({ voucher: { title: dir } }),
  };
  const fallback = (dir: "asc" | "desc") => ({ createdAt: dir });

  test("maps a whitelisted column with direction", () => {
    expect(buildOrderBy({ sort: "user", dir: "asc" }, map, fallback)).toEqual({ userEmail: "asc" });
    expect(buildOrderBy({ sort: "voucher", dir: "desc" }, map, fallback)).toEqual({ voucher: { title: "desc" } });
  });

  test("falls back for unknown/empty sort (no arbitrary orderBy)", () => {
    expect(buildOrderBy({ sort: "DROP TABLE", dir: "asc" }, map, fallback)).toEqual({ createdAt: "asc" });
    expect(buildOrderBy({ sort: undefined, dir: "desc" }, map, fallback)).toEqual({ createdAt: "desc" });
  });
});
