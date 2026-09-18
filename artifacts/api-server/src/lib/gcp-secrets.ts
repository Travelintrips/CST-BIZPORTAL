import { validateUpstreamBaseUrl } from "../routes/proxy-policy";

let upstreamOriginPromise: Promise<URL> | null = null;

const BACKEND_ORIGIN_KEYS = new Set([
  "BIZPORTAL_BACKEND_API_ORIGIN",
  "bizportal_backend_api_origin",
  "BACKEND_URL",
  "backendUrl",
  "API_URL",
  "apiUrl",
  "API_ORIGIN",
  "apiOrigin",
]);

function findBackendOrigin(value: unknown): string | null {
  if (typeof value === "string") {
    return /^https?:\/\//i.test(value.trim()) ? value.trim() : null;
  }
  if (!value || typeof value !== "object") return null;

  const record = value as Record<string, unknown>;
  for (const [key, nested] of Object.entries(record)) {
    if (BACKEND_ORIGIN_KEYS.has(key)) {
      const candidate = findBackendOrigin(nested);
      if (candidate) return candidate;
    }
  }

  for (const nested of Object.values(record)) {
    if (!nested || typeof nested !== "object") continue;
    const candidate = findBackendOrigin(nested);
    if (candidate) return candidate;
  }
  return null;
}

function extractBackendOrigin(secretValue: string, secretName: string): string | null {
  const trimmed = secretValue.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const origin = findBackendOrigin(parsed);
    if (origin) return origin;
  } catch {
    // Report a useful configuration error below without exposing the secret.
  }

  return null;
}

function validateConfiguredOrigin(
  value: string,
  source: string,
  options: { allowLocalHttp?: boolean } = {},
): URL {
  try {
    const configuredUrl = validateUpstreamBaseUrl(value, options);
    // BIZPORTAL_API_ORIGIN is an origin, not an API route prefix. Ignore an
    // accidental path in the stored config so requests keep their /api/... path
    // exactly once.
    return new URL(configuredUrl.origin);
  } catch {
    let details = "unparseable";
    try {
      const parsed = new URL(value);
      details = [
        `protocol=${parsed.protocol || "missing"}`,
        `hostname=${parsed.hostname ? "present" : "missing"}`,
        `rootPath=${parsed.pathname === "/"}`,
        `credentials=${Boolean(parsed.username || parsed.password)}`,
      ].join(", ");
    } catch {
      // Keep the diagnostic free of the secret value.
    }
    throw new Error(`${source} API origin failed validation (${details})`);
  }
}

async function loadUpstreamOrigin(): Promise<URL> {
  const environment = (process.env.APP_ENV ?? process.env.NODE_ENV ?? "development")
    .trim()
    .toLowerCase();
  const isProduction = environment === "production";
  const environmentOriginKey = isProduction
    ? "BIZPORTAL_API_ORIGIN_PROD"
    : "BIZPORTAL_API_ORIGIN_DEV";
  // The backend origin is a development-only convenience. Production must
  // always use its explicit environment origin so a leaked localhost value
  // cannot override the deployed upstream configuration.
  const backendOrigin = isProduction
    ? undefined
    : process.env.BIZPORTAL_BACKEND_API_ORIGIN?.trim();
  const explicitOrigin = backendOrigin || process.env[environmentOriginKey]?.trim();
  if (!explicitOrigin) {
    throw new Error(
      `BIZPORTAL_BACKEND_API_ORIGIN or ${environmentOriginKey} is not configured; ${isProduction ? "production" : "development"} cannot fall back to another environment`,
    );
  }

  const configuredOrigin = validateConfiguredOrigin(
    explicitOrigin,
    backendOrigin ? "BIZPORTAL_BACKEND_API_ORIGIN" : environmentOriginKey,
    {
      allowLocalHttp:
        !isProduction &&
        backendOrigin !== undefined &&
        /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?\/?$/i.test(backendOrigin),
    },
  );
  if (isProduction && configuredOrigin.hostname.endsWith(".replit.dev")) {
    throw new Error("BIZPORTAL_API_ORIGIN_PROD cannot use an ephemeral Replit development host");
  }
  return configuredOrigin;
}

export function getConfiguredUpstreamOrigin(): Promise<URL> {
  upstreamOriginPromise ??= loadUpstreamOrigin();
  return upstreamOriginPromise;
}