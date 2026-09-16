import {
  extractDatabaseUrl,
  getDatabaseSecretName,
  readGcpSecret,
  validateDatabaseUrl,
} from "./gcp-database-secret";

function isProductionEnvironment(): boolean {
  return process.env.APP_ENV === "production" || process.env.NODE_ENV === "production";
}

/**
 * Return the synchronous environment-only database URL.
 *
 * This is kept for CLI tools such as drizzle-kit. Runtime callers should use
 * resolveDatabaseUrl() so the GCP Secret Manager fallback is available.
 */
export function getDatabaseUrl(): string | undefined {
  const isProduction = isProductionEnvironment();
  return (
    (isProduction
      ? process.env.SUPABASE_DATABASE_URL
      : process.env.SUPABASE_DATABASE_URL_DEV) ??
    process.env.SUPABASE_PG_URL ??
    process.env.DATABASE_URL
  );
}

export async function resolveDatabaseUrl(): Promise<string> {
  const environmentUrl = getDatabaseUrl()?.trim();
  if (environmentUrl) {
    return validateDatabaseUrl(environmentUrl, "Database environment variable");
  }

  const isProduction = isProductionEnvironment();
  const secretKey = isProduction ? "SUPABASE_DATABASE_URL" : "SUPABASE_DATABASE_URL_DEV";
  const secretName = getDatabaseSecretName(isProduction);
  const secretValue = await readGcpSecret(secretName);
  const databaseUrl = extractDatabaseUrl(secretValue, secretKey);

  if (!databaseUrl) {
    throw new Error(`GCP secret ${secretName} does not contain ${secretKey}`);
  }

  return validateDatabaseUrl(databaseUrl, `GCP secret ${secretName}.${secretKey}`);
}