import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";
import { resolveDatabaseUrl } from "./connection";

const { Pool } = pg;

let concretePoolPromise: Promise<InstanceType<typeof Pool>> | null = null;
let resolvedRuntimeDatabaseUrl: string | null = null;

async function createConcretePool(): Promise<InstanceType<typeof Pool>> {
  const databaseUrl = await resolveDatabaseUrl();
  resolvedRuntimeDatabaseUrl = databaseUrl;

  return new Pool({
    connectionString: databaseUrl,
    max: Number(process.env.DB_POOL_MAX ?? 10),
    idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS ?? 30_000),
    connectionTimeoutMillis: Number(process.env.DB_CONNECTION_TIMEOUT_MS ?? 10_000),
    // Supabase's transaction pooler rejects statement_timeout as a startup
    // parameter. Keep the timeout client-side instead of breaking every connection.
    query_timeout: Number(process.env.DB_QUERY_TIMEOUT_MS ?? 45_000),
  });
}

async function getConcretePool(): Promise<InstanceType<typeof Pool>> {
  if (!concretePoolPromise) {
    concretePoolPromise = createConcretePool().catch((error) => {
      // Allow a later request to retry after an environment/configuration fix.
      concretePoolPromise = null;
      throw error;
    });
  }
  return concretePoolPromise;
}

const lazyPool = {
  query: async (...args: unknown[]) => {
    const concretePool = await getConcretePool();
    return (concretePool.query as (...queryArgs: unknown[]) => unknown)(...args);
  },
  connect: async (...args: unknown[]) => {
    const concretePool = await getConcretePool();
    return (concretePool.connect as (...connectArgs: unknown[]) => unknown)(...args);
  },
  end: async () => {
    if (!concretePoolPromise) return;
    const concretePool = await concretePoolPromise;
    concretePoolPromise = null;
    resolvedRuntimeDatabaseUrl = null;
    await concretePool.end();
  },
} as unknown as InstanceType<typeof Pool>;

/**
 * Lazy database pool.
 *
 * Importing the API must not require GCP/database connectivity. The concrete
 * pool is created on the first DB-backed request instead, so liveness/static
 * frontend can start even when readiness is degraded.
 */
export const pool = lazyPool;
export const db = drizzle(pool, { schema });

export async function getRuntimeDatabaseUrl(): Promise<string> {
  await getConcretePool();
  if (!resolvedRuntimeDatabaseUrl) {
    throw new Error("Database URL was not resolved");
  }
  return resolvedRuntimeDatabaseUrl;
}

export * from "./schema";
export { getDatabaseUrl, resolveDatabaseUrl } from "./connection";
