import {
  extractDatabaseUrl,
  getDatabaseSecretName,
  readSecret,
  validateDatabaseUrl,
} from "./gcp-database-secret";

type AppEnvironment = "development" | "production";

function resolveAppEnvironment(): AppEnvironment {
  const appEnv = process.env.APP_ENV?.trim().toLowerCase();

  if (appEnv === "development" || appEnv === "production") {
    return appEnv;
  }

  if (appEnv) {
    throw new Error(
      `Unsupported APP_ENV="${process.env.APP_ENV}". Expected "development" or "production".`,
    );
  }

  // NODE_ENV describes the build/runtime mode, not which Supabase project a
  // deployed instance is allowed to use. Keep this fallback only for legacy
  // environments that have not set APP_ENV yet.
  return process.env.NODE_ENV === "production" ? "production" : "development";
}

function isProductionEnvironment(): boolean {
  return resolveAppEnvironment() === "production";
}

/**
 * Return the synchronous environment-only database URL.
 *
 * This is kept for CLI tools such as drizzle-kit. Runtime callers should use
 * resolveDatabaseUrl() so the GCP Secret Manager fallback is available.
 *
 * The generic DATABASE_URL is intentionally not a fallback here. The
 * application database is the environment-specific Supabase database, and
 * Replit's managed database must never be selected implicitly.
 *
 * IMPORTANT: APP_ENV is authoritative. A development deployment commonly
 * still has NODE_ENV=production because it runs an optimized production build.
 * In that case APP_ENV=development must continue to select the DEV database.
 */
export function getDatabaseUrl(): string | undefined {
  const isProduction = isProductionEnvironment();

  if (isProduction) {
    return process.env.SUPABASE_DATABASE_URL;
  }

  return process.env.SUPABASE_DATABASE_URL_DEV;
}

export async function resolveDatabaseUrl(): Promise<string> {
  const environment = resolveAppEnvironment();
  const environmentUrl = getDatabaseUrl()?.trim();

  if (environmentUrl) {
    return validateDatabaseUrl(
      environmentUrl,
      `${environment.toUpperCase()} database environment variable`,
    );
  }

  const isProduction = environment === "production";
  const secretKey = isProduction
    ? "SUPABASE_DATABASE_URL"
    : "SUPABASE_DATABASE_URL_DEV";
  const secretName = getDatabaseSecretName(isProduction);
  const secretValue = await readSecret(secretName);
  const databaseUrl = extractDatabaseUrl(secretValue, secretKey);

  if (!databaseUrl) {
    throw new Error(
      `GCP secret ${secretName} does not contain ${secretKey}; refusing to fall back to the opposite environment database`,
    );
  }

  return validateDatabaseUrl(
    databaseUrl,
    `GCP secret ${secretName}.${secretKey}`,
  );
}
