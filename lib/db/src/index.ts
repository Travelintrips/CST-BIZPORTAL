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

  const isProduction = process.env.NODE_ENV === "production";
  const configuredPoolMax = Number(process.env.DB_POOL_MAX);
  const poolMax =
    Number.isFinite(configuredPoolMax) && configuredPoolMax > 0
      ? Math.max(1, Math.min(5, Math.floor(configuredPoolMax)))
      : isProduction
        ? 2
        : 5;

  return new Pool({
    connectionString: databaseUrl,
    // Tenant POS, BizPortal, Sport Center, dan AI Core berbagi project Supabase
    // production yang sama. Default pg-pool=10 per Hostinger process dapat
    // menghabiskan limit session Supavisor saat rolling deploy.
    max: poolMax,
    idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS ?? (isProduction ? 5_000 : 30_000)),
    connectionTimeoutMillis: Number(process.env.DB_CONNECTION_TIMEOUT_MS ?? 8_000),
    // Supabase's transaction pooler rejects statement_timeout as a startup
    // parameter. Keep the timeout client-side instead of breaking every connection.
    query_timeout: Number(process.env.DB_QUERY_TIMEOUT_MS ?? 30_000),
    application_name: "cst-bizportal",
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
export { getDatabaseSecretName, readSecret } from "./gcp-database-secret";
