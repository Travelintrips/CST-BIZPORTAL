import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";
import { getDatabaseUrl } from "./connection";

const { Pool } = pg;

const databaseUrl = getDatabaseUrl();

if (!databaseUrl) {
  throw new Error(
    "A Supabase Postgres URL is required. Set SUPABASE_DATABASE_URL_DEV for development or SUPABASE_DATABASE_URL for production.",
  );
}

export const pool = new Pool({ connectionString: databaseUrl });
export const db = drizzle(pool, { schema });

export * from "./schema";
export { getDatabaseUrl } from "./connection";
