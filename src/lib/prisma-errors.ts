import { Prisma } from "@prisma/client";

export function isUniqueViolation(e: unknown): boolean {
  return (
    e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002"
  );
}

export function isNotFound(e: unknown): boolean {
  return (
    e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025"
  );
}

// --- Unique-violation field extraction ------------------------------------
//
// Under Prisma 7 + the PrismaPg driver adapter, P2002 errors no longer put the
// violated columns on `e.meta.target`. They now live at
// `e.meta.driverAdapterError.cause.constraint.fields` (a string[]). Legacy
// Prisma (and some paths) still use `e.meta.target` (a string or string[]).
// We read BOTH so callers are robust across versions/drivers.

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null
    ? (v as Record<string, unknown>)
    : undefined;
}

/** Fields from the new PrismaPg driver-adapter shape, if present. */
function adapterConstraintFields(meta: Record<string, unknown>): string[] {
  const adapterErr = asRecord(meta["driverAdapterError"]);
  const cause = asRecord(adapterErr?.["cause"]);
  const constraint = asRecord(cause?.["constraint"]);
  const fields = constraint?.["fields"];
  if (Array.isArray(fields)) {
    return fields.filter((f): f is string => typeof f === "string");
  }
  return [];
}

/** Fields from the legacy `meta.target` shape (string or string[]). */
function legacyTargetFields(meta: Record<string, unknown>): string[] {
  const target = meta["target"];
  if (Array.isArray(target)) {
    return target.filter((f): f is string => typeof f === "string");
  }
  if (typeof target === "string") {
    return [target];
  }
  return [];
}

/**
 * The column names involved in a unique-constraint (P2002) violation, reading
 * both the new PrismaPg driver-adapter shape and the legacy `meta.target`.
 * Returns [] for anything that isn't a P2002 error (or when no fields are
 * discoverable).
 */
export function uniqueViolationFields(e: unknown): string[] {
  if (
    !(e instanceof Prisma.PrismaClientKnownRequestError) ||
    e.code !== "P2002"
  ) {
    return [];
  }
  const meta = asRecord(e.meta);
  if (!meta) return [];
  const fields = adapterConstraintFields(meta);
  return fields.length > 0 ? fields : legacyTargetFields(meta);
}

/** True when a P2002 violation involves the given column. */
export function uniqueViolationOn(e: unknown, field: string): boolean {
  return uniqueViolationFields(e).includes(field);
}
