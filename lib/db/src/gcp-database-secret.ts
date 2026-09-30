import crypto from "node:crypto";

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
const DATABASE_URL_KEYS = new Set([
  "SUPABASE_DATABASE_URL_DEV",
  "SUPABASE_DATABASE_URL",
]);

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

async function getAccessToken(
  credentials: ServiceAccountCredentials,
  signal?: AbortSignal,
): Promise<string> {
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
    signal,
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

export async function readSecret(
  secretName: string,
  options: { signal?: AbortSignal } = {},
): Promise<string> {
  const credentials = getCredentials();
  const accessToken = await getAccessToken(credentials, options.signal);
  const resource = [
    "https://secretmanager.googleapis.com/v1",
    `projects/${encodeURIComponent(credentials.project_id!)}`,
    `secrets/${encodeURIComponent(secretName)}`,
    "versions/latest:access",
  ].join("/");

  const response = await fetch(resource, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: options.signal,
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

function findDatabaseUrl(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object") return null;

  const record = value as Record<string, unknown>;
  for (const [recordKey, nested] of Object.entries(record)) {
    if (recordKey === key && typeof nested === "string" && nested.trim()) {
      return nested.trim();
    }
  }

  for (const nested of Object.values(record)) {
    const candidate = findDatabaseUrl(nested, key);
    if (candidate) return candidate;
  }
  return null;
}

export function extractDatabaseUrl(secretValue: string, key: string): string | null {
  if (!DATABASE_URL_KEYS.has(key)) {
    throw new Error(`Unsupported database URL secret key: ${key}`);
  }

  const trimmed = secretValue.trim();
  if (/^postgres(?:ql)?:\/\//i.test(trimmed)) return trimmed;

  try {
    return findDatabaseUrl(JSON.parse(trimmed) as unknown, key);
  } catch {
    return null;
  }
}

export function validateDatabaseUrl(value: string, source: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
      throw new Error("unsupported protocol");
    }
    if (!url.hostname || url.username === "" || url.password === "") {
      throw new Error("missing connection components");
    }
    return value.trim();
  } catch {
    throw new Error(`${source} must be a valid postgres:// or postgresql:// URL`);
  }
}

export function getDatabaseSecretName(isProduction: boolean): string {
  const configuredName = process.env[
    isProduction
      ? "GCP_SECRET_MANAGER_SECRET_NAME_PROD"
      : "GCP_SECRET_MANAGER_SECRET_NAME_DEV"
  ]?.trim();
  if (configuredName) return configuredName;
  return isProduction ? DEFAULT_PROD_SECRET_NAME : DEFAULT_DEV_SECRET_NAME;
}