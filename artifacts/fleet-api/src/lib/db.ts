import pg from "pg";

const { Pool } = pg;

type AppEnvironment = "development" | "production";
const DEV_SUPABASE_PROJECT_REF = "xssrfshdrtdfupgqwfdw";
const PROD_SUPABASE_PROJECT_REF = "nzdweipzckfszczzqtuw";

function resolveEnvironment(): AppEnvironment {
  const value=String(process.env.APP_ENV ?? "").trim().toLowerCase();
  if(value==="development"||value==="production") return value;
  throw new Error('APP_ENV wajib "development" atau "production".');
}

export function getRuntimeDatabaseUrl(): string {
  const env=resolveEnvironment();
  const key=env==="production"?"SUPABASE_DATABASE_URL":"SUPABASE_DATABASE_URL_DEV";
  const value=String(process.env[key] ?? "").trim();
  if(!value) throw new Error(`${key} wajib dikonfigurasi untuk Fleet API.`);

  const parsed=new URL(value);
  const haystack=`${parsed.hostname} ${decodeURIComponent(parsed.username)}`.toLowerCase();
  const expected=env==="production"?PROD_SUPABASE_PROJECT_REF:DEV_SUPABASE_PROJECT_REF;
  const forbidden=env==="production"?DEV_SUPABASE_PROJECT_REF:PROD_SUPABASE_PROJECT_REF;

  if(haystack.includes(forbidden)) {
    throw new Error(`${key} menunjuk project Supabase environment yang salah (${forbidden}).`);
  }
  if(!haystack.includes(expected)) {
    throw new Error(`${key} tidak mengidentifikasi project Supabase ${env.toUpperCase()} yang diharapkan (${expected}).`);
  }
  return value;
}

export const pool = new Pool({
  connectionString: getRuntimeDatabaseUrl(),
  max: Math.max(2, Number(process.env.DB_POOL_MAX ?? 10) || 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 15_000,
  ssl: process.env.DB_SSL === "disable" ? false : { rejectUnauthorized: false },
});
