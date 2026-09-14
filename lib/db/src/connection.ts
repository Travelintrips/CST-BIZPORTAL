/**
 * Select the Supabase Postgres connection for the current Replit environment.
 *
 * The environment-specific URLs take precedence over the shared URL so
 * development never accidentally connects to production. DATABASE_URL remains
 * a compatibility fallback for local tooling and existing Replit setups.
 */
export function getDatabaseUrl(): string | undefined {
  const isProduction = process.env.APP_ENV === "production" || process.env.NODE_ENV === "production";
  return (
    (isProduction
      ? process.env.SUPABASE_DATABASE_URL
      : process.env.SUPABASE_DATABASE_URL_DEV) ??
    process.env.SUPABASE_PG_URL ??
    process.env.DATABASE_URL
  );
}