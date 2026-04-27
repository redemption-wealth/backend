import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
  pool: pg.Pool | undefined;
};

function createPrismaClient(): PrismaClient {
  if (globalForPrisma.pool) {
    globalForPrisma.pool.end().catch(() => {});
    globalForPrisma.pool = undefined;
  }

  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    idleTimeoutMillis: 60_000,
    connectionTimeoutMillis: 10_000,
  });

  pool.on("error", (err) => {
    console.error("[db] pool error, resetting client:", err.message);
    globalForPrisma.prisma = undefined;
    globalForPrisma.pool = undefined;
  });

  globalForPrisma.pool = pool;
  const client = new PrismaClient({ adapter: new PrismaPg(pool) });
  globalForPrisma.prisma = client;
  return client;
}

function getPrisma(): PrismaClient {
  return globalForPrisma.prisma ?? createPrismaClient();
}

// Proxy so handlers always see the current live Prisma client.
// If the pool errored and the global was reset, the next property access
// rebuilds a fresh client+pool instead of returning a dead reference.
export const prisma = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    const client = getPrisma();
    const value = Reflect.get(client, prop);
    return typeof value === "function" ? value.bind(client) : value;
  },
});
