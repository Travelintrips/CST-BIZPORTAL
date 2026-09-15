import crypto from "node:crypto";
import { Router, type Request, type Response } from "express";

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

const DEV_SESSION_COOKIE = "bizportal_dev_session";
const DEV_SESSION_TTL_SECONDS = 8 * 60 * 60;

export function isDevelopmentEnvironment(): boolean {
  const appEnvironment = process.env.APP_ENV?.trim().toLowerCase();
  const nodeEnvironment = process.env.NODE_ENV?.trim().toLowerCase();

  if (appEnvironment !== undefined) {
    return appEnvironment === "development";
  }

  return nodeEnvironment === "development";
}

function getSessionSecret(): string | null {
  const secret = process.env.SESSION_SECRET;
  return secret && secret.length >= 32 ? secret : null;
}

function getDevIdentitySecret(): string | null {
  const secret = process.env.DEV_IDENTITY_SECRET ?? process.env.SESSION_SECRET;
  return secret && secret.length >= 32 ? secret : null;
}

function getAllowedEmails(): string[] {
  return (process.env.DEV_LOGIN_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
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
  response.setHeader(
    "Set-Cookie",
    `${DEV_SESSION_COOKIE}=${value}; Max-Age=${DEV_SESSION_TTL_SECONDS}; Path=/; HttpOnly; SameSite=Lax`,
  );
}

function clearSessionCookie(response: Response): void {
  response.setHeader(
    "Set-Cookie",
    `${DEV_SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`,
  );
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

function getSafeRedirect(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) {
    return "/";
  }
  return value;
}

export function createDevAuthRouter(): Router {
  const router = Router();

  router.get("/auth/dev-users", (_request, response) => {
    if (!isDevelopmentEnvironment()) return response.status(404).json({ error: "Not found" });
    return response.json({ users: getDevUsers() });
  });

  router.post("/auth/dev-login", (request, response) => {
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

  router.get("/auth/user", (request, response, next) => {
    if (!isDevelopmentEnvironment()) return next();

    const user = getDevSession(request);
    if (user) return response.json({ user });
    return next();
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
    if (!isDevelopmentEnvironment() || !getDevSession(request)) return next();

    clearSessionCookie(response);
    return response.redirect(getSafeRedirect(request.query.redirect));
  });

  return router;
}