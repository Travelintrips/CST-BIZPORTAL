const clean = (value) => String(value ?? "").trim();

export function resolveFleetEnvironment(env = process.env) {
  const appEnv = clean(env.APP_ENV || env.NODE_ENV).toLowerCase();
  const baseUrl = clean(env.APP_BASE_URL).toLowerCase();
  const databaseUrl = clean(env.DATABASE_URL).toLowerCase();
  const supabaseUrl = clean(env.SUPABASE_URL).toLowerCase();

  const isProd = appEnv === "production" || baseUrl.includes("://fleet.cstlogistic.co.id");
  const isDev = appEnv === "development" || baseUrl.includes("://dev-fleet.cstlogistic.co.id");

  if (isProd && isDev) {
    throw new Error("Fleet environment is ambiguous: both production and development markers are present.");
  }
  if (!isProd && !isDev) {
    throw new Error("Fleet APP_ENV/APP_BASE_URL must explicitly identify development or production.");
  }

  return { appEnv: isProd ? "production" : "development", baseUrl, databaseUrl, supabaseUrl };
}

function hasDevMarker(value) {
  return /(?:^|[^a-z0-9])(dev|development|staging|test)(?:[^a-z0-9]|$)/i.test(value);
}

function hasProdMarker(value) {
  return /(?:^|[^a-z0-9])(prod|production)(?:[^a-z0-9]|$)/i.test(value);
}

export function assertFleetEnvironmentIsolation(env = process.env) {
  const resolved = resolveFleetEnvironment(env);
  const targets = [resolved.databaseUrl, resolved.supabaseUrl].filter(Boolean);

  if (!targets.length) {
    throw new Error("Fleet database configuration is required.");
  }

  if (resolved.appEnv === "production" && targets.some(hasDevMarker)) {
    throw new Error("Fleet PROD refused to start with a DEV/staging/test database marker.");
  }
  if (resolved.appEnv === "development" && targets.some(hasProdMarker)) {
    throw new Error("Fleet DEV refused to start with a PROD database marker.");
  }

  if (resolved.appEnv === "production") {
    for (const key of ["AUTH_CLIENT_SECRET"]) {
      if (!clean(env[key])) throw new Error(`Fleet PROD requires ${key}.`);
    }
  }

  if (clean(env.CENTRAL_FINANCE_WRITE_ENABLED).toLowerCase() === "true") {
    if (!clean(env.CENTRAL_FINANCE_BASE_URL) || !clean(env.CENTRAL_FINANCE_SERVICE_TOKEN)) {
      throw new Error("Central Finance write mode requires base URL and service token.");
    }
  }

  return resolved;
}
