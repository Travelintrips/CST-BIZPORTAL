import {
  extractDatabaseUrl,
  getDatabaseSecretName,
  readSecret,
  validateDatabaseUrl,
} from "./gcp-database-secret";

type AppEnvironment = "development" | "production";

const DEV_SUPABASE_PROJECT_REF = "xssrfshdrtdfupgqwfdw";
const PROD_SUPABASE_PROJECT_REF = "nzdweipzckfszczzqtuw";

function resolveAppEnvironment(): AppEnvironment {
  const appEnv = process.env.APP_ENV?.trim().toLowerCase();

  if (appEnv === "development" || appEnv === "production") {
    return appEnv;
  }

  if (!appEnv) {
    throw new Error(
      'APP_ENV is required and must be explicitly set to "development" or "production". Refusing to infer database target from NODE_ENV.',
    );
  }

  throw new Error(
    `Unsupported APP_ENV="${process.env.APP_ENV}". Expected "development" or "production".`,
  );
}

function isProductionEnvironment(): boolean {
  return resolveAppEnvironment() === "production";
}

function assertExpectedSupabaseProject(
  value: string,
  environment: AppEnvironment,
  source: string,
): string {
  const expectedRef =
    environment === "production"
      ? PROD_SUPABASE_PROJECT_REF
      : DEV_SUPABASE_PROJECT_REF;

  const forbiddenRef =
    environment === "production"
      ? DEV_SUPABASE_PROJECT_REF
      : PROD_SUPABASE_PROJECT_REF;

  const parsed = new URL(value);
  const hostname = parsed.hostname.toLowerCase();
  const username = decodeURIComponent(parsed.username).toLowerCase();
  const haystack = `${hostname} ${username}`;

  if (haystack.includes(forbiddenRef)) {
    throw new Error(
      `${source} points to the opposite environment Supabase project (${forbiddenRef}); refusing database connection`,
    );
  }

  if (!haystack.includes(expectedRef)) {
    throw new Error(
      `${source} does not identify the expected ${environment.toUpperCase()} Supabase project (${expectedRef}); refusing database connection`,
    );
  }

  return value;
}

function validateEnvironmentDatabaseUrl(
  value: string,
  environment: AppEnvironment,
  source: string,
): string {
  const validated = validateDatabaseUrl(value, source);
  return assertExpectedSupabaseProject(validated, environment, source);
}

/**
 * Return the synchronous environment-only database URL.
 *
 * APP_ENV is mandatory and authoritative. NODE_ENV only controls the runtime
 * build mode and must never decide which database is selected.
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
    return validateEnvironmentDatabaseUrl(
      environmentUrl,
      environment,
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

  return validateEnvironmentDatabaseUrl(
    databaseUrl,
    environment,
    `GCP secret ${secretName}.${secretKey}`,
  );
}
