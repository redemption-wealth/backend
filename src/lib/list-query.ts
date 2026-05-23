// Shared helpers for list endpoints: safe, whitelisted sorting driven by the
// `sort`/`dir` (a.k.a. `sortBy`/`sortOrder`) query params the DataTable writes
// to the URL. Keeping the column→orderBy mapping per-route prevents arbitrary
// `orderBy` (and thus avoids ordering by un-indexed / unintended columns).

export interface SortParams {
  sort: string | undefined;
  dir: "asc" | "desc";
}

interface QueryReader {
  req: { query: (key: string) => string | undefined };
}

export function parseSort(c: QueryReader): SortParams {
  const sort = c.req.query("sort") || c.req.query("sortBy");
  const dirRaw = (c.req.query("dir") || c.req.query("sortOrder") || "desc").toLowerCase();
  const dir: "asc" | "desc" = dirRaw === "asc" ? "asc" : "desc";
  return { sort, dir };
}

// Resolve a whitelisted orderBy. `map` is keyed by the column id the frontend
// sends; values are builders so the chosen direction is applied consistently.
export function buildOrderBy<T>(
  { sort, dir }: SortParams,
  map: Record<string, (dir: "asc" | "desc") => T>,
  fallback: (dir: "asc" | "desc") => T,
): T {
  if (sort && map[sort]) return map[sort](dir);
  return fallback(dir);
}
