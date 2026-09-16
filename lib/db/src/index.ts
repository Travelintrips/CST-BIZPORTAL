import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";
import { resolveDatabaseUrl } from "./connection";

const { Pool } = pg;

const databaseUrl = await resolveDatabaseUrl();

export const pool = new Pool({ connectionString: databaseUrl });
export const db = drizzle(pool, { schema });

export * from "./schema";
export { getDatabaseUrl, resolveDatabaseUrl } from "./connection";
