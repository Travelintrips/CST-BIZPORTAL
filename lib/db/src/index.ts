import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";
import { resolveDatabaseUrl } from "./connection";

const { Pool } = pg;

const databaseUrl = await resolveDatabaseUrl();

export const pool = new Pool({
  connectionString: databaseUrl,
  max: Number(process.env.DB_POOL_MAX ?? 10),
  idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS ?? 30_000),
  connectionTimeoutMillis: Number(process.env.DB_CONNECTION_TIMEOUT_MS ?? 10_000),
  // Supabase's transaction pooler rejects statement_timeout as a startup
  // parameter. Keep the timeout client-side instead of breaking every connection.
  query_timeout: Number(process.env.DB_QUERY_TIMEOUT_MS ?? 45_000),
});
export const db = drizzle(pool, { schema });

export * from "./schema";
export { getDatabaseUrl, resolveDatabaseUrl } from "./connection";
