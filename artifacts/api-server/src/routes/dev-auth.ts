import crypto from "node:crypto";
import { Router, type Request, type Response } from "express";
import {
  getDatabaseSecretName,
  getRuntimeDatabaseUrl,
  pool,
  readSecret,
} from "@workspace/db";

export interface DevAuthUser {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  role: string;
  companyId: number | null;
}

interface DevSession extends DevAuthUser {
  issuedAt: number;
  expiresAt: number;
}

export interface ProductionSession {
  id: string;
  email: string;
  issuedAt: number;
  expiresAt: number;
}

const DEV_SESSION_COOKIE = "bizportal_dev_session";
const PRODUCTION_SESSION_COOKIE = "bizportal_supabase_session";
const DEV_SESSION_TTL_SECONDS = 8 * 60 * 60;

export function isDevelopmentEnvironment(): boolean {
  const appEnvironment = process.env.APP_ENV?.trim().toLowerCase();
  const nodeEnvironment = process.env.NODE_ENV?.trim().toLowerCase();

  if (appEnvironment !== undefined) {
    return appEnvironment === "development";
  }

  return nodeEnvironment === "development";
}

let initializedProductionSessionSecret: string | null = null;

function deriveProductionSessionSecret(databaseCredential: string): string {
  return crypto
    .createHash("sha256")
    .update("cst-bizportal:production-session:v1\0", "utf8")
    .update(databaseCredential, "utf8")
    .digest("hex");
}

function findSecretString(value: unknown, keys: Set<string>): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;

  for (const [key, nested] of Object.entries(record)) {
    if (keys.has(key) && typeof nested === "string" && nested.trim().length >= 32) {
      return nested.trim();
    }
  }

  for (const nested of Object.values(record)) {
    const found = findSecretString(nested, keys);
    if (found) return found;
  }
  return null;
}

async function getBundledProductionSessionSecret(): Promise<string | null> {
  if (!process.env.GCP_SECRET_MANAGER_BOOTSTRAP_JSON?.trim()) return null;

  const secretValue = await readSecret(getDatabaseSecretName(true));
  try {
    return findSecretString(
      JSON.parse(secretValue) as unknown,
      new Set(["BIZPORTAL_SESSION_SECRET", "SESSION_SECRET"]),
    );
  } catch {
    return null;
  }
}

function getExplicitSessionSecret(): string | null {
  for (const candidate of [
    process.env.BIZPORTAL_SESSION_SECRET,
    process.env.SESSION_SECRET,
  ]) {
    const explicitSecret = candidate?.trim();
    if (explicitSecret && explicitSecret.length >= 32) return explicitSecret;
  }
  return null;
}

function getSessionSecret(): string | null {
  return getExplicitSessionSecret() ?? initializedProductionSessionSecret;
}

export async function initializeProductionSessionSigning(): Promise<void> {
  if (isDevelopmentEnvironment()) return;

  const explicitSecret = getExplicitSessionSecret();
  if (explicitSecret) {
    initializedProductionSessionSecret = explicitSecret;
    return;
  }

  // Standalone Hostinger starts the compiled API directly, so secrets stored
  // in the canonical GCP bundle are not automatically copied into process.env.
  // Load the session secret explicitly from the same production bundle first.
  // This keeps signing stable across restarts and database credential rotation.
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const bundledSecret = await getBundledProductionSessionSecret();
      if (bundledSecret) {
        initializedProductionSessionSecret = bundledSecret;
        return;
      }

      // Backward-compatible safety net for installations whose production
      // bundle predates SESSION_SECRET. The DB URL is already a required,
      // high-entropy credential and is resolved through the canonical runtime
      // path, not by assuming it exists in process.env.
      const databaseCredential = await getRuntimeDatabaseUrl();
      initializedProductionSessionSecret =
        deriveProductionSessionSecret(databaseCredential);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Production session signing could not be initialized");
}

function getDevIdentitySecret(): string | null {
  const secret = process.env.DEV_IDENTITY_SECRET ?? process.env.SESSION_SECRET;
  return secret && secret.length >= 32 ? secret : null;
}

function getAllowedEmails(): string[] {
  const configuredEmails = (process.env.DEV_LOGIN_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);

  return configuredEmails;
}

function getDevUsers(): DevAuthUser[] {
  const role = process.env.DEV_LOGIN_ROLE?.trim() || "admin";
  return getAllowedEmails().map((email) => {
    const name = email.split("@", 1)[0].replace(/[._-]+/g, " ").trim();
    const firstName = name ? name.replace(/\b\w/g, (letter) => letter.toUpperCase()) : null;
    return {
      id: `dev:${crypto.createHash("sha256").update(email).digest("hex").slice(0, 16)}`,
      email,
      firstName,
      lastName: null,
      role,
      companyId: null,
    };
  });
}

function encode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function sign(value: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(value).digest("base64url");
}

export function getDevIdentitySignature(user: DevAuthUser): string | null {
  if (!isDevelopmentEnvironment()) return null;

  const secret = getDevIdentitySecret();
  if (!secret) return null;

  return sign(`${user.email}\n${user.role}`, secret);
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function getCookie(request: Request, name: string): string | null {
  const cookieHeader = request.headers.cookie;
  if (!cookieHeader) return null;

  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return null;
}

function setSessionCookie(response: Response, session: DevSession): void {
  const secret = getSessionSecret();
  if (!secret) throw new Error("SESSION_SECRET is unavailable");

  const payload = encode(JSON.stringify(session));
  const value = `${payload}.${sign(payload, secret)}`;
  response.append(
    "Set-Cookie",
    `${DEV_SESSION_COOKIE}=${value}; Max-Age=${DEV_SESSION_TTL_SECONDS}; Path=/; HttpOnly; SameSite=Lax`,
  );
}

export function setProductionSessionCookie(response: Response, session: ProductionSession): void {
  const secret = getSessionSecret();
  if (!secret) throw new Error("SESSION_SECRET is unavailable");

  const payload = encode(JSON.stringify(session));
  const value = `${payload}.${sign(payload, secret)}`;
  const maxAge = Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000));
  response.append(
    "Set-Cookie",
    `${PRODUCTION_SESSION_COOKIE}=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`,
  );
}

function clearSessionCookie(response: Response): void {
  response.setHeader(
    "Set-Cookie",
    `${DEV_SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`,
  );
}

function clearProductionSessionCookie(response: Response): void {
  response.setHeader(
    "Set-Cookie",
    `${PRODUCTION_SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`,
  );
}

function decodeSignedCookie<T>(request: Request, cookieName: string): T | null {
  const secret = getSessionSecret();
  const raw = getCookie(request, cookieName);
  if (!secret || !raw) return null;

  const separator = raw.lastIndexOf(".");
  if (separator <= 0) return null;

  const payload = raw.slice(0, separator);
  const signature = raw.slice(separator + 1);
  if (!safeEqual(sign(payload, secret), signature)) return null;

  try {
    return JSON.parse(decode(payload)) as T;
  } catch {
    return null;
  }
}

export function getDevSession(request: Request): DevAuthUser | null {
  if (!isDevelopmentEnvironment()) return null;

  const secret = getSessionSecret();
  const raw = getCookie(request, DEV_SESSION_COOKIE);
  if (!secret || !raw) return null;

  const separator = raw.lastIndexOf(".");
  if (separator <= 0) return null;

  const payload = raw.slice(0, separator);
  const signature = raw.slice(separator + 1);
  if (!safeEqual(sign(payload, secret), signature)) return null;

  try {
    const session = JSON.parse(decode(payload)) as DevSession;
    if (
      !session ||
      typeof session.email !== "string" ||
      typeof session.expiresAt !== "number" ||
      session.expiresAt <= Date.now()
    ) {
      return null;
    }

    const configuredUser = getDevUsers().find((user) => user.email === session.email);
    return configuredUser ?? null;
  } catch {
    return null;
  }
}

export function getProductionSession(request: Request): ProductionSession | null {
  if (isDevelopmentEnvironment()) return null;

  const session = decodeSignedCookie<ProductionSession>(request, PRODUCTION_SESSION_COOKIE);
  if (
    !session ||
    typeof session.id !== "string" ||
    typeof session.email !== "string" ||
    typeof session.expiresAt !== "number" ||
    session.expiresAt <= Date.now()
  ) {
    return null;
  }

  return {
    ...session,
    email: session.email.trim().toLowerCase(),
  };
}

function getSupabaseConfig(): { url: string; anonKey: string } | null {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  return { url: url.replace(/\/+$/, ""), anonKey };
}

async function verifySupabaseAccessToken(accessToken: string): Promise<{
  id: string;
  email: string;
  expiresAt: number;
} | null> {
  const config = getSupabaseConfig();
  if (!config) throw new Error("Supabase Auth configuration is unavailable");

  const response = await fetch(`${config.url}/auth/v1/user`, {
    headers: {
      apikey: config.anonKey,
      authorization: `Bearer ${accessToken}`,
    },
  });
  if (!response.ok) return null;

  const user = await response.json() as {
    id?: unknown;
    email?: unknown;
  };
  if (typeof user.id !== "string" || typeof user.email !== "string") return null;

  const tokenParts = accessToken.split(".");
  let expiresAt = 0;
  let usedOtp = false;
  try {
    const claims = JSON.parse(decode(tokenParts[1] ?? "")) as {
      exp?: unknown;
      amr?: unknown;
    };
    if (typeof claims.exp === "number") expiresAt = claims.exp * 1000;
    usedOtp = Array.isArray(claims.amr) && claims.amr.some((entry) => (
      typeof entry === "object"
      && entry !== null
      && "method" in entry
      && (entry as { method?: unknown }).method === "otp"
    ));
  } catch {
    return null;
  }
  if (!usedOtp || expiresAt <= Date.now()) return null;

  return {
    id: user.id,
    email: user.email.trim().toLowerCase(),
    expiresAt,
  };
}

export async function getProductionUser(session: ProductionSession): Promise<DevAuthUser | null> {
  const result = await pool.query<{ user_data: Record<string, unknown> }>(
    `select to_jsonb(u) user_data
     from public.users u
     where lower(coalesce(to_jsonb(u)->>'email', '')) = $1
     limit 1`,
    [session.email],
  );
  const userData = result.rows[0]?.user_data;
  if (!userData) return null;

  const email = typeof userData.email === "string" ? userData.email.trim().toLowerCase() : "";
  const role = typeof userData.role === "string" ? userData.role.trim().toLowerCase() : "";
  if (email !== session.email || !role) return null;

  const rawCompanyId = userData.company_id ?? userData.companyId;
  const parsedCompanyId = rawCompanyId === null || rawCompanyId === undefined
    ? null
    : Number(rawCompanyId);
  return {
    id: session.id,
    email,
    firstName: typeof userData.first_name === "string" ? userData.first_name : null,
    lastName: typeof userData.last_name === "string" ? userData.last_name : null,
    role,
    companyId: parsedCompanyId !== null && Number.isInteger(parsedCompanyId) && parsedCompanyId > 0
      ? parsedCompanyId
      : null,
  };
}

function getSafeRedirect(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) {
    return "/";
  }
  return value;
}

export function createDevAuthRouter(): Router {
  const router = Router();

  router.post("/auth/supabase-exchange", async (request, response): Promise<void> => {
    if (isDevelopmentEnvironment()) {
      response.status(404).json({ error: "Not found" });
      return;
    }

    const accessToken =
      typeof request.body?.access_token === "string"
        ? request.body.access_token.trim()
        : "";
    if (!accessToken) {
      response.status(401).json({ error: "Session Supabase tidak tersedia." });
      return;
    }
    if (!getSessionSecret()) {
      response.status(503).json({ error: "Konfigurasi session server belum tersedia." });
      return;
    }

    try {
      const verified = await verifySupabaseAccessToken(accessToken);
      if (!verified) {
        response.status(401).json({ error: "Session Supabase tidak valid atau sudah berakhir." });
        return;
      }

      const now = Date.now();
      const productionSession = {
        id: verified.id,
        email: verified.email,
        issuedAt: now,
        expiresAt: verified.expiresAt,
      };
      const user = await getProductionUser(productionSession);
      if (!user || user.role !== "admin") {
        response.status(403).json({
          error: "Email atau kode OTP tidak dapat digunakan untuk login admin.",
        });
        return;
      }

      setProductionSessionCookie(response, productionSession);
      response.json({ user });
    } catch (error) {
      request.log.error({ error }, "Supabase access token verification failed");
      response.status(503).json({ error: "Verifikasi session Supabase tidak tersedia." });
    }
  });

  router.get("/auth/dev-users", (_request, response) => {
    if (!isDevelopmentEnvironment()) return response.status(404).json({ error: "Not found" });
    return response.json({ users: getDevUsers() });
  });

  router.post("/auth/dev-login", async (request, response) => {
    if (!isDevelopmentEnvironment()) return response.status(404).json({ error: "Not found" });

    const email =
      typeof request.body?.email === "string"
        ? request.body.email.trim().toLowerCase()
        : "";
    const configuredUsers = getDevUsers();
    // An empty email is the intentional development auto-login path. Prefer
    // an explicitly configured admin, then fall back to the first dev user.
    const user = email
      ? configuredUsers.find((candidate) => candidate.email === email)
      : configuredUsers.find((candidate) => candidate.role === "admin") ?? configuredUsers[0];

    if (!getSessionSecret()) {
      return response.status(503).json({
        error: "Dev login belum aktif: SESSION_SECRET harus tersedia.",
      });
    }
    if (configuredUsers.length === 0) {
      return response.status(503).json({
        error: "Dev login belum dikonfigurasi: DEV_LOGIN_EMAILS masih kosong.",
      });
    }
    if (!user) {
      return response.status(403).json({
        error: "Email belum diizinkan untuk Dev Login.",
      });
    }

    const now = Date.now();
    setSessionCookie(response, {
      ...user,
      issuedAt: now,
      expiresAt: now + DEV_SESSION_TTL_SECONDS * 1000,
    });
    return response.json({ user });
  });

  router.get("/auth/user", async (request, response, next): Promise<void> => {
    if (!isDevelopmentEnvironment()) {
      const session = getProductionSession(request);
      if (!session) {
        response.status(401).json({ error: "Unauthorized" });
        return;
      }
      try {
        const user = await getProductionUser(session);
        if (!user) {
          response.status(403).json({ error: "Forbidden" });
          return;
        }
        response.json({ user });
      } catch (error) {
        request.log.error({ error }, "Failed to load production auth user");
        response.status(503).json({ error: "Authorization service unavailable" });
      }
      return;
    }

    const user = getDevSession(request);
    if (user) {
      response.json({ user });
      return;
    }
    next();
  });

  router.get("/users/me", (request, response, next) => {
    if (!isDevelopmentEnvironment()) return next();

    const user = getDevSession(request);
    if (!user) return next();

    return response.json({
      id: user.id,
      email: user.email,
      name: [user.firstName, user.lastName].filter(Boolean).join(" ") || user.email,
      role: user.role,
    });
  });

  router.get("/logout", (request, response, next) => {
    if (!isDevelopmentEnvironment()) {
      clearProductionSessionCookie(response);
      response.redirect(getSafeRedirect(request.query.redirect));
      return;
    }
    if (!getDevSession(request)) return next();

    clearSessionCookie(response);
    return response.redirect(getSafeRedirect(request.query.redirect));
  });

  return router;
}