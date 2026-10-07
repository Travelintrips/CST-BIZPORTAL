import crypto from "node:crypto";
import { Router, type Request } from "express";
import { pool } from "@workspace/db";
import {
  getDevSession,
  getProductionSession,
  getProductionUser,
  isDevelopmentEnvironment,
  type DevAuthUser,
} from "./dev-auth";

const router = Router();

const OAUTH_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const DEFAULT_SOURCE_EMAIL = "travelincars01@gmail.com";
const STATE_MAX_AGE_MS = 10 * 60 * 1000;
const GMAIL_SEARCH_QUERY =
  "newer_than:365d has:attachment {filename:pdf filename:jpg filename:jpeg filename:png} {invoice tagihan faktur billing}";

type GmailSourceStatus = {
  oauthConfigured: boolean;
  expectedEmail: string;
  connected: boolean;
  connectedEmail: string | null;
  lastSyncAt: string | null;
  lastSyncCount: number;
  lastSyncStatus: string | null;
  redirectUri: string;
  scope: string;
};

type SignedState = {
  companyId: number;
  actorEmail: string;
  returnPath: string;
  issuedAt: number;
  nonce: string;
};

function parsePositiveInt(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function sourceEmail(): string {
  return (process.env.GMAIL_INVOICE_SOURCE_EMAIL || DEFAULT_SOURCE_EMAIL)
    .trim()
    .toLowerCase();
}

function googleClientId(): string {
  return process.env.GOOGLE_CLIENT_ID?.trim() ?? "";
}

function googleClientSecret(): string {
  return process.env.GOOGLE_CLIENT_SECRET?.trim() ?? "";
}

function safeReturnPath(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) {
    return "/finance/recon-config?tab=invoice-sources";
  }
  return value;
}

function getRedirectUri(request: Request): string {
  const configured = process.env.GMAIL_INVOICE_OAUTH_REDIRECT_URI?.trim();
  if (configured) return configured;

  const forwardedProto = String(request.headers["x-forwarded-proto"] ?? "")
    .split(",")[0]
    .trim();
  const protocol = forwardedProto || request.protocol || "https";
  const forwardedHost = String(request.headers["x-forwarded-host"] ?? "")
    .split(",")[0]
    .trim();
  const host = forwardedHost || request.get("host");
  if (!host) throw new Error("Unable to determine public BizPortal host");
  return `${protocol}://${host}/api/recon-classification/invoice-sources/gmail/callback`;
}

async function getActor(request: Request): Promise<DevAuthUser | null> {
  if (isDevelopmentEnvironment()) return getDevSession(request);
  const session = getProductionSession(request);
  if (!session) return null;
  return getProductionUser(session);
}

async function requireFinanceAdmin(request: Request): Promise<DevAuthUser | null> {
  const actor = await getActor(request);
  if (!actor) return null;
  const role = actor.role.trim().toLowerCase();
  return ["admin", "owner", "super_admin"].includes(role) ? actor : null;
}

function configPrefix(companyId: number): string {
  return `GMAIL_INVOICE_SOURCE_${companyId}_`;
}

async function getConfig(companyId: number, suffix: string): Promise<string | null> {
  const key = `${configPrefix(companyId)}${suffix}`;
  const result = await pool.query<{ value: string | null }>(
    `select value from public.app_config where key = $1 limit 1`,
    [key],
  );
  return result.rows[0]?.value ?? null;
}

async function setConfig(
  companyId: number,
  suffix: string,
  value: string | null,
  options: { secret?: boolean; description?: string; actor?: string } = {},
): Promise<void> {
  const key = `${configPrefix(companyId)}${suffix}`;
  await pool.query(
    `insert into public.app_config(key, value, is_secret, description, environment, updated_at, updated_by)
     values($1, $2, $3, $4, 'production', now(), $5)
     on conflict (key) do update
       set value = excluded.value,
           is_secret = excluded.is_secret,
           description = excluded.description,
           updated_at = now(),
           updated_by = excluded.updated_by`,
    [
      key,
      value,
      options.secret ?? false,
      options.description ?? null,
      options.actor ?? null,
    ],
  );
}

function encryptionKey(): Buffer {
  const secret = googleClientSecret();
  if (!secret) throw new Error("GOOGLE_CLIENT_SECRET is not configured");
  return crypto
    .createHash("sha256")
    .update("cst-bizportal:gmail-invoice-source:v1\0", "utf8")
    .update(secret, "utf8")
    .digest();
}

function encryptRefreshToken(refreshToken: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(refreshToken, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    "v1",
    iv.toString("base64url"),
    tag.toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".");
}

function decryptRefreshToken(value: string): string {
  const [version, ivRaw, tagRaw, encryptedRaw] = value.split(".");
  if (version !== "v1" || !ivRaw || !tagRaw || !encryptedRaw) {
    throw new Error("Stored Gmail refresh token has an unsupported format");
  }
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(ivRaw, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedRaw, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function stateSecret(): string {
  const secret = googleClientSecret();
  if (!secret) throw new Error("GOOGLE_CLIENT_SECRET is not configured");
  return crypto
    .createHash("sha256")
    .update("cst-bizportal:gmail-oauth-state:v1\0", "utf8")
    .update(secret, "utf8")
    .digest("base64url");
}

function signState(payload: SignedState): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = crypto
    .createHmac("sha256", stateSecret())
    .update(encoded)
    .digest("base64url");
  return `${encoded}.${signature}`;
}

function parseState(raw: unknown): SignedState | null {
  if (typeof raw !== "string") return null;
  const separator = raw.lastIndexOf(".");
  if (separator <= 0) return null;

  const encoded = raw.slice(0, separator);
  const suppliedSignature = raw.slice(separator + 1);
  const expectedSignature = crypto
    .createHmac("sha256", stateSecret())
    .update(encoded)
    .digest("base64url");

  const left = Buffer.from(suppliedSignature);
  const right = Buffer.from(expectedSignature);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return null;

  try {
    const parsed = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as SignedState;
    if (
      !parsePositiveInt(parsed.companyId) ||
      typeof parsed.actorEmail !== "string" ||
      typeof parsed.returnPath !== "string" ||
      typeof parsed.issuedAt !== "number" ||
      typeof parsed.nonce !== "string" ||
      Date.now() - parsed.issuedAt > STATE_MAX_AGE_MS ||
      parsed.issuedAt > Date.now() + 60_000
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function redirectWithResult(
  response: any,
  returnPath: string,
  params: Record<string, string>,
): void {
  const target = new URL(safeReturnPath(returnPath), "https://bizportal.local");
  for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
  response.redirect(303, `${target.pathname}${target.search}`);
}

async function exchangeAuthorizationCode(
  code: string,
  redirectUri: string,
): Promise<{ access_token: string; refresh_token?: string }> {
  const body = new URLSearchParams({
    code,
    client_id: googleClientId(),
    client_secret: googleClientSecret(),
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const payload = (await response.json()) as Record<string, unknown>;
  if (!response.ok || typeof payload.access_token !== "string") {
    throw new Error(
      typeof payload.error === "string"
        ? `Google OAuth token exchange failed: ${payload.error}`
        : "Google OAuth token exchange failed",
    );
  }
  return {
    access_token: payload.access_token,
    refresh_token:
      typeof payload.refresh_token === "string" ? payload.refresh_token : undefined,
  };
}

async function refreshAccessToken(refreshToken: string): Promise<string> {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: googleClientId(),
      client_secret: googleClientSecret(),
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const payload = (await response.json()) as Record<string, unknown>;
  if (!response.ok || typeof payload.access_token !== "string") {
    throw new Error(
      typeof payload.error === "string"
        ? `Google refresh failed: ${payload.error}`
        : "Google refresh failed",
    );
  }
  return payload.access_token;
}

async function gmailProfile(accessToken: string): Promise<{ emailAddress: string }> {
  const response = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/profile",
    { headers: { authorization: `Bearer ${accessToken}` } },
  );
  if (!response.ok) throw new Error("Unable to read Gmail profile");
  const payload = (await response.json()) as { emailAddress?: unknown };
  if (typeof payload.emailAddress !== "string") {
    throw new Error("Gmail profile did not return an email address");
  }
  return { emailAddress: payload.emailAddress.trim().toLowerCase() };
}

async function readStatus(request: Request, companyId: number): Promise<GmailSourceStatus> {
  const [
    encryptedToken,
    connectedEmail,
    lastSyncAt,
    lastSyncCount,
    lastSyncStatus,
  ] = await Promise.all([
    getConfig(companyId, "REFRESH_TOKEN"),
    getConfig(companyId, "EMAIL"),
    getConfig(companyId, "LAST_SYNC_AT"),
    getConfig(companyId, "LAST_SYNC_COUNT"),
    getConfig(companyId, "LAST_SYNC_STATUS"),
  ]);

  return {
    oauthConfigured: Boolean(googleClientId() && googleClientSecret()),
    expectedEmail: sourceEmail(),
    connected: Boolean(encryptedToken && connectedEmail),
    connectedEmail: connectedEmail || null,
    lastSyncAt: lastSyncAt || null,
    lastSyncCount: Number(lastSyncCount ?? 0) || 0,
    lastSyncStatus: lastSyncStatus || null,
    redirectUri: getRedirectUri(request),
    scope: OAUTH_SCOPE,
  };
}

router.get("/recon-classification/invoice-sources/gmail/status", async (req, res) => {
  try {
    const actor = await requireFinanceAdmin(req);
    if (!actor) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const companyId = parsePositiveInt(req.query.company_id);
    if (!companyId) {
      res.status(400).json({ error: "company_id wajib" });
      return;
    }
    res.json(await readStatus(req, companyId));
  } catch (error) {
    req.log.error({ error }, "Failed to read Gmail invoice source status");
    res.status(503).json({ error: "Status sumber invoice Gmail belum tersedia." });
  }
});

router.post("/recon-classification/invoice-sources/gmail/connect", async (req, res) => {
  try {
    const actor = await requireFinanceAdmin(req);
    if (!actor) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const companyId = parsePositiveInt(req.body?.company_id);
    if (!companyId) {
      res.status(400).json({ error: "company_id wajib" });
      return;
    }
    if (!googleClientId() || !googleClientSecret()) {
      res.status(503).json({
        error: "Google OAuth belum dikonfigurasi di server BizPortal.",
        code: "GOOGLE_OAUTH_NOT_CONFIGURED",
        redirectUri: getRedirectUri(req),
      });
      return;
    }

    const redirectUri = getRedirectUri(req);
    const returnPath = safeReturnPath(req.body?.return_path);
    const state = signState({
      companyId,
      actorEmail: actor.email.trim().toLowerCase(),
      returnPath,
      issuedAt: Date.now(),
      nonce: crypto.randomBytes(16).toString("base64url"),
    });

    const authorizeUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authorizeUrl.search = new URLSearchParams({
      client_id: googleClientId(),
      redirect_uri: redirectUri,
      response_type: "code",
      scope: OAUTH_SCOPE,
      access_type: "offline",
      include_granted_scopes: "true",
      prompt: "consent select_account",
      login_hint: sourceEmail(),
      state,
    }).toString();

    res.json({ url: authorizeUrl.toString(), redirectUri });
  } catch (error) {
    req.log.error({ error }, "Failed to start Gmail invoice OAuth");
    res.status(503).json({ error: "Koneksi Gmail belum dapat dimulai." });
  }
});

router.get("/recon-classification/invoice-sources/gmail/callback", async (req, res) => {
  const rawState = req.query.state;
  let parsedState: SignedState | null = null;
  try {
    parsedState = parseState(rawState);
  } catch (error) {
    req.log.error({ error }, "Gmail OAuth state validation failed");
  }

  const fallbackPath = "/finance/recon-config?tab=invoice-sources";
  if (!parsedState) {
    redirectWithResult(res, fallbackPath, {
      gmail: "error",
      reason: "invalid_state",
    });
    return;
  }

  try {
    const actor = await requireFinanceAdmin(req);
    if (!actor) {
      redirectWithResult(res, parsedState.returnPath, {
        gmail: "error",
        reason: "session_expired",
      });
      return;
    }
    if (actor.email.trim().toLowerCase() !== parsedState.actorEmail) {
      redirectWithResult(res, parsedState.returnPath, {
        gmail: "error",
        reason: "actor_mismatch",
      });
      return;
    }
    if (typeof req.query.error === "string") {
      redirectWithResult(res, parsedState.returnPath, {
        gmail: "error",
        reason: req.query.error,
      });
      return;
    }
    const code = typeof req.query.code === "string" ? req.query.code : "";
    if (!code) {
      redirectWithResult(res, parsedState.returnPath, {
        gmail: "error",
        reason: "missing_code",
      });
      return;
    }

    const redirectUri = getRedirectUri(req);
    const tokens = await exchangeAuthorizationCode(code, redirectUri);
    const profile = await gmailProfile(tokens.access_token);
    if (profile.emailAddress !== sourceEmail()) {
      redirectWithResult(res, parsedState.returnPath, {
        gmail: "error",
        reason: "wrong_account",
      });
      return;
    }

    const priorEncrypted = await getConfig(parsedState.companyId, "REFRESH_TOKEN");
    if (!tokens.refresh_token && !priorEncrypted) {
      redirectWithResult(res, parsedState.returnPath, {
        gmail: "error",
        reason: "refresh_token_missing",
      });
      return;
    }

    if (tokens.refresh_token) {
      await setConfig(
        parsedState.companyId,
        "REFRESH_TOKEN",
        encryptRefreshToken(tokens.refresh_token),
        {
          secret: true,
          description: "Encrypted OAuth refresh token for Gmail invoice source",
          actor: actor.email,
        },
      );
    }
    await setConfig(parsedState.companyId, "EMAIL", profile.emailAddress, {
      description: "Connected Gmail invoice source address",
      actor: actor.email,
    });
    await setConfig(parsedState.companyId, "LAST_SYNC_STATUS", "connected", {
      description: "Last Gmail invoice source synchronization status",
      actor: actor.email,
    });

    redirectWithResult(res, parsedState.returnPath, { gmail: "connected" });
  } catch (error) {
    req.log.error(
      { error, companyId: parsedState.companyId },
      "Gmail invoice OAuth callback failed",
    );
    redirectWithResult(res, parsedState.returnPath, {
      gmail: "error",
      reason: "oauth_failed",
    });
  }
});

router.post("/recon-classification/invoice-sources/gmail/sync", async (req, res) => {
  try {
    const actor = await requireFinanceAdmin(req);
    if (!actor) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const companyId = parsePositiveInt(req.body?.company_id);
    if (!companyId) {
      res.status(400).json({ error: "company_id wajib" });
      return;
    }

    const encryptedToken = await getConfig(companyId, "REFRESH_TOKEN");
    if (!encryptedToken) {
      res.status(409).json({
        error: "Gmail belum terhubung.",
        code: "GMAIL_NOT_CONNECTED",
      });
      return;
    }

    const refreshToken = decryptRefreshToken(encryptedToken);
    const accessToken = await refreshAccessToken(refreshToken);
    const profile = await gmailProfile(accessToken);
    if (profile.emailAddress !== sourceEmail()) {
      res.status(409).json({
        error: `Akun Gmail terhubung bukan ${sourceEmail()}.`,
        code: "GMAIL_ACCOUNT_MISMATCH",
      });
      return;
    }

    const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
    listUrl.search = new URLSearchParams({
      q: GMAIL_SEARCH_QUERY,
      maxResults: "100",
    }).toString();
    const gmailResponse = await fetch(listUrl, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const payload = (await gmailResponse.json()) as {
      messages?: Array<{ id?: string }>;
      resultSizeEstimate?: number;
      error?: { message?: string };
    };
    if (!gmailResponse.ok) {
      throw new Error(payload.error?.message || "Gmail message scan failed");
    }

    const scanCount = Array.isArray(payload.messages) ? payload.messages.length : 0;
    const now = new Date().toISOString();
    await Promise.all([
      setConfig(companyId, "LAST_SYNC_AT", now, {
        description: "Last successful Gmail invoice source sync time",
        actor: actor.email,
      }),
      setConfig(companyId, "LAST_SYNC_COUNT", String(scanCount), {
        description: "Invoice-like Gmail messages seen in latest scan",
        actor: actor.email,
      }),
      setConfig(companyId, "LAST_SYNC_STATUS", "ok", {
        description: "Last Gmail invoice source synchronization status",
        actor: actor.email,
      }),
    ]);

    res.json({
      ok: true,
      email: profile.emailAddress,
      scanned: scanCount,
      resultSizeEstimate:
        typeof payload.resultSizeEstimate === "number"
          ? payload.resultSizeEstimate
          : scanCount,
      syncedAt: now,
      query: GMAIL_SEARCH_QUERY,
    });
  } catch (error) {
    req.log.error({ error }, "Gmail invoice source sync failed");
    res.status(503).json({
      error: "Gmail terhubung tetapi pembacaan email belum berhasil.",
      code: "GMAIL_SYNC_FAILED",
    });
  }
});

router.post("/recon-classification/invoice-sources/gmail/disconnect", async (req, res) => {
  try {
    const actor = await requireFinanceAdmin(req);
    if (!actor) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const companyId = parsePositiveInt(req.body?.company_id);
    if (!companyId) {
      res.status(400).json({ error: "company_id wajib" });
      return;
    }

    await Promise.all([
      setConfig(companyId, "REFRESH_TOKEN", null, {
        secret: true,
        description: "Encrypted OAuth refresh token for Gmail invoice source",
        actor: actor.email,
      }),
      setConfig(companyId, "EMAIL", null, {
        description: "Connected Gmail invoice source address",
        actor: actor.email,
      }),
      setConfig(companyId, "LAST_SYNC_STATUS", "disconnected", {
        description: "Last Gmail invoice source synchronization status",
        actor: actor.email,
      }),
    ]);
    res.json({ ok: true });
  } catch (error) {
    req.log.error({ error }, "Failed to disconnect Gmail invoice source");
    res.status(503).json({ error: "Gmail belum dapat diputuskan." });
  }
});

export default router;
