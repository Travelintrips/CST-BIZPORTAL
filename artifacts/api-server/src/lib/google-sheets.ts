import crypto from "node:crypto";

interface GoogleServiceAccount {
  client_email?: string;
  private_key?: string;
  token_uri?: string;
}

interface GoogleTokenResponse {
  access_token?: string;
}

interface SpreadsheetMetadata {
  properties?: { title?: string };
  sheets?: Array<{ properties?: { title?: string } }>;
}

function encodeBase64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function getCredentials(): Required<Pick<GoogleServiceAccount, "client_email" | "private_key">> &
  GoogleServiceAccount {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not configured");

  let credentials: GoogleServiceAccount;
  try {
    credentials = JSON.parse(raw) as GoogleServiceAccount;
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON");
  }

  if (!credentials.client_email || !credentials.private_key) {
    throw new Error("Google service account is missing client_email or private_key");
  }
  return credentials as Required<Pick<GoogleServiceAccount, "client_email" | "private_key">> &
    GoogleServiceAccount;
}

async function getAccessToken(credentials: ReturnType<typeof getCredentials>): Promise<string> {
  const tokenUri = credentials.token_uri ?? "https://oauth2.googleapis.com/token";
  const now = Math.floor(Date.now() / 1000);
  const header = encodeBase64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = encodeBase64Url(
    JSON.stringify({
      iss: credentials.client_email,
      scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
      aud: tokenUri,
      iat: now,
      exp: now + 3600,
    }),
  );
  const unsigned = `${header}.${claim}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const assertion = `${unsigned}.${signer.sign(credentials.private_key, "base64url")}`;

  const response = await fetch(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!response.ok) throw new Error(`Google OAuth failed (${response.status})`);

  const data = (await response.json()) as GoogleTokenResponse;
  if (!data.access_token) throw new Error("Google OAuth did not return an access token");
  return data.access_token;
}

export async function inspectSpreadsheet(
  spreadsheetId: string,
): Promise<{ title: string; tabs: string[]; serviceAccountEmail: string }> {
  const credentials = getCredentials();
  const accessToken = await getAccessToken(credentials);
  const url = new URL(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}`,
  );
  url.searchParams.set("fields", "properties.title,sheets.properties.title");

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    if (response.status === 403 || response.status === 404) {
      throw new Error("Spreadsheet tidak ditemukan atau belum dibagikan ke Service Account");
    }
    throw new Error(`Google Sheets API failed (${response.status})`);
  }

  const data = (await response.json()) as SpreadsheetMetadata;
  return {
    title: data.properties?.title ?? "Untitled spreadsheet",
    tabs: (data.sheets ?? [])
      .map((sheet) => sheet.properties?.title)
      .filter((title): title is string => Boolean(title)),
    serviceAccountEmail: credentials.client_email,
  };
}

export async function readSpreadsheetValues(
  spreadsheetId: string,
  tabName: string,
): Promise<string[][]> {
  const credentials = getCredentials();
  const accessToken = await getAccessToken(credentials);
  const range = `${tabName}!A:ZZ`;
  const url = new URL(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`,
  );
  url.searchParams.set("majorDimension", "ROWS");

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    if (response.status === 403 || response.status === 404) {
      throw new Error("Spreadsheet tidak ditemukan atau belum dibagikan ke Service Account");
    }
    throw new Error(`Google Sheets API failed (${response.status})`);
  }

  const data = (await response.json()) as { values?: unknown[][] };
  return (data.values ?? []).map((row) =>
    row.map((value) => (value == null ? "" : String(value))),
  );
}