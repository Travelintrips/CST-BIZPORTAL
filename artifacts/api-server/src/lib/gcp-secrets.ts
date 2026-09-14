import crypto from "node:crypto";
import { validateUpstreamBaseUrl } from "../routes/proxy-policy";

type ServiceAccountCredentials = {
  project_id?: string;
  client_email?: string;
  private_key?: string;
  token_uri?: string;
};

type SecretPayload = {
  payload?: {
    data?: string;
  };
};

const DEFAULT_DEV_SECRET_NAME = "cst-super-app-development";
const DEFAULT_PROD_SECRET_NAME = "cst-super-app-production";
const DEFAULT_UPSTREAM_ORIGIN = "https://cstlogistic.co.id";

let upstreamOriginPromise: Promise<URL> | null = null;

function encodeBase64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function signJwt(input: string, privateKey: string): string {
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(input);
  signer.end();
  return signer.sign(privateKey, "base64url");
}

function getCredentials(): ServiceAccountCredentials {
  const raw = process.env.GCP_SECRET_MANAGER_BOOTSTRAP_JSON;
  if (!raw) {
    throw new Error("GCP_SECRET_MANAGER_BOOTSTRAP_JSON is not configured");
  }

  let credentials: ServiceAccountCredentials;
  try {
    credentials = JSON.parse(raw) as ServiceAccountCredentials;
  } catch {
    throw new Error("GCP_SECRET_MANAGER_BOOTSTRAP_JSON is not valid JSON");
  }

  if (!credentials.project_id || !credentials.client_email || !credentials.private_key) {
    throw new Error("GCP Secret Manager credentials are missing project_id, client_email, or private_key");
  }

  return credentials;
}

async function getAccessToken(credentials: ServiceAccountCredentials): Promise<string> {
  const tokenUri = credentials.token_uri ?? "https://oauth2.googleapis.com/token";
  const now = Math.floor(Date.now() / 1000);
  const header = encodeBase64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = encodeBase64Url(
    JSON.stringify({
      iss: credentials.client_email,
      scope: "https://www.googleapis.com/auth/cloud-platform",
      aud: tokenUri,
      iat: now,
      exp: now + 3600,
    }),
  );
  const assertion = `${header}.${claim}.${signJwt(`${header}.${claim}`, credentials.private_key!)}`;

  const response = await fetch(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!response.ok) {
    throw new Error(`GCP OAuth token request failed (${response.status})`);
  }

  const data = await response.json() as { access_token?: string };
  if (!data.access_token) {
    throw new Error("GCP OAuth response did not contain an access token");
  }
  return data.access_token;
}

async function readSecret(secretName: string): Promise<string> {
  const credentials = getCredentials();
  const accessToken = await getAccessToken(credentials);
  const resource = [
    "https://secretmanager.googleapis.com/v1",
    `projects/${encodeURIComponent(credentials.project_id!)}`,
    `secrets/${encodeURIComponent(secretName)}`,
    "versions/latest:access",
  ].join("/");

  const response = await fetch(resource, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`GCP Secret Manager read failed for ${secretName} (${response.status})`);
  }

  const data = await response.json() as SecretPayload;
  const encoded = data.payload?.data;
  if (!encoded) {
    throw new Error(`GCP secret ${secretName} has no payload`);
  }
  return Buffer.from(encoded, "base64").toString("utf8").trim();
}

function findOrigin(value: unknown): string | null {
  if (typeof value === "string") {
    return /^https?:\/\//i.test(value.trim()) ? value.trim() : null;
  }
  if (!value || typeof value !== "object") return null;

  const record = value as Record<string, unknown>;
  const preferredKeys = [
    "BIZPORTAL_API_ORIGIN",
    "bizportal_api_origin",
    "API_ORIGIN",
    "apiOrigin",
    "apiUrl",
    "baseUrl",
    "origin",
    "url",
  ];
  for (const key of preferredKeys) {
    const candidate = findOrigin(record[key]);
    if (candidate) return candidate;
  }

  for (const nested of Object.values(record)) {
    const candidate = findOrigin(nested);
    if (candidate) return candidate;
  }
  return null;
}

function extractOrigin(secretValue: string, secretName: string): string {
  const trimmed = secretValue.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const origin = findOrigin(parsed);
    if (origin) return origin;
  } catch {
    // Report a useful configuration error below without exposing the secret.
  }

  throw new Error(`GCP secret ${secretName} does not contain a valid API origin`);
}

function validateConfiguredOrigin(value: string, source: string): URL {
  try {
    const configuredUrl = validateUpstreamBaseUrl(value);
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
  const explicitOrigin = process.env.BIZPORTAL_API_ORIGIN?.trim();
  if (explicitOrigin) return validateConfiguredOrigin(explicitOrigin, "BIZPORTAL_API_ORIGIN");

  const environment = (process.env.APP_ENV ?? process.env.NODE_ENV ?? "development")
    .trim()
    .toLowerCase();
  const secretName =
    environment === "production"
      ? process.env.GCP_BIZPORTAL_API_SECRET_PROD ?? DEFAULT_PROD_SECRET_NAME
      : process.env.GCP_BIZPORTAL_API_SECRET_DEV ?? DEFAULT_DEV_SECRET_NAME;

  if (process.env.GCP_SECRET_MANAGER_BOOTSTRAP_JSON) {
    const origin = extractOrigin(await readSecret(secretName), secretName);
    return validateConfiguredOrigin(origin, `GCP secret ${secretName}`);
  }

  // Preserve the existing local setup when GCP Secret Manager is not configured.
  return validateUpstreamBaseUrl(DEFAULT_UPSTREAM_ORIGIN);
}

export function getConfiguredUpstreamOrigin(): Promise<URL> {
  upstreamOriginPromise ??= loadUpstreamOrigin();
  return upstreamOriginPromise;
}