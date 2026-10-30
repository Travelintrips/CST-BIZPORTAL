import { EventEmitter } from "node:events";
import http, {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
} from "node:http";
import { type AddressInfo } from "node:net";
import https from "node:https";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import app from "../app";
import {
  initializeProductionSessionSigning,
  getProductionSession,
  setProductionSessionCookie,
} from "./dev-auth";

const allowedEmail = "admin@example.com";
const sessionSecret = "development-session-secret-with-32-bytes!!";

type ApiResponse = {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
};

type UpstreamBehavior =
  | { kind: "response"; statusCode: number; cookies?: string[] }
  | { kind: "transport-error" };

const originalEnvironment = {
  APP_ENV: process.env.APP_ENV,
  NODE_ENV: process.env.NODE_ENV,
  BIZPORTAL_API_ORIGIN_DEV: process.env.BIZPORTAL_API_ORIGIN_DEV,
  DEV_LOGIN_EMAILS: process.env.DEV_LOGIN_EMAILS,
  SESSION_SECRET: process.env.SESSION_SECRET,
  BIZPORTAL_SESSION_SECRET: process.env.BIZPORTAL_SESSION_SECRET,
  SUPABASE_DATABASE_URL: process.env.SUPABASE_DATABASE_URL,
  DATABASE_URL: process.env.DATABASE_URL,
};

let server: Server;
let port: number;

function restoreEnvironment(): void {
  for (const [name, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}

function requestApi(
  method: string,
  path: string,
  body?: Record<string, string>,
  cookie?: string,
): Promise<ApiResponse> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: {
          ...(body ? { "content-type": "application/json" } : {}),
          ...(cookie ? { cookie } : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 500,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );

    request.on("error", reject);
    if (body) request.end(JSON.stringify(body));
    else request.end();
  });
}

function mockUpstreamLogin(behavior: UpstreamBehavior): ReturnType<typeof vi.spyOn> {
  const requestMock = vi.spyOn(https, "request");
  requestMock.mockImplementation(((...args: unknown[]) => {
    const callback = args[2] as (response: IncomingMessage) => void;
    const request = new EventEmitter() as EventEmitter & {
      end: (body?: string) => void;
      setTimeout: (timeout: number, callback?: () => void) => EventEmitter;
    };

    request.end = () => {
      queueMicrotask(() => {
        if (behavior.kind === "transport-error") {
          request.emit("error", new Error("upstream unavailable"));
          return;
        }

        const response = new EventEmitter() as EventEmitter & {
          statusCode?: number;
          headers: IncomingHttpHeaders;
          resume: () => void;
        };
        response.statusCode = behavior.statusCode;
        response.headers = behavior.cookies
          ? { "set-cookie": behavior.cookies }
          : {};
        response.resume = () => {};
        callback(response as unknown as IncomingMessage);
        response.emit("end");
      });
    };
    request.setTimeout = () => request;

    return request as unknown as ReturnType<typeof https.request>;
  }) as never);

  return requestMock;
}

beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  restoreEnvironment();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

beforeEach(() => {
  process.env.APP_ENV = "development";
  process.env.NODE_ENV = "development";
  process.env.BIZPORTAL_API_ORIGIN_DEV = "https://development.example.test";
  process.env.DEV_LOGIN_EMAILS = allowedEmail;
  process.env.SESSION_SECRET = sessionSecret;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("production session signing fallback", () => {
  it("derives a stable signing key from the required database credential when SESSION_SECRET is absent", async () => {
    process.env.APP_ENV = "production";
    process.env.NODE_ENV = "production";
    delete process.env.SESSION_SECRET;
    delete process.env.BIZPORTAL_SESSION_SECRET;
    process.env.SUPABASE_DATABASE_URL = "postgresql://postgres.nzdweipzckfszczzqtuw:strong-password@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres";

    await initializeProductionSessionSigning();

    const cookies: string[] = [];
    const response = {
      append: (_name: string, value: string) => {
        cookies.push(value);
        return response;
      },
    } as unknown as Response;

    expect(() => setProductionSessionCookie(response, {
      id: "user-1",
      email: "admin@example.com",
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    })).not.toThrow();

    expect(cookies[0]).toMatch(/^bizportal_supabase_session=[^;]+;/);
    expect(cookies[0]).toContain("HttpOnly");
    expect(cookies[0]).toContain("Secure");
  });
});


describe("DEV signed session cookie round trip", () => {
  it("reads a valid signed session in DEV and rejects a tampered cookie", async () => {
    await initializeProductionSessionSigning();
    const cookies: string[] = [];
    const response = {
      append: (_name: string, value: string) => {
        cookies.push(value);
        return response;
      },
    } as unknown as Response;
    const session = {
      id: "admin-1", email: allowedEmail,
      issuedAt: Date.now(), expiresAt: Date.now() + 60_000,
    };
    setProductionSessionCookie(response, session);
    const cookiePair = cookies[0].split(";")[0];
    expect(getProductionSession({ headers: { cookie: cookiePair } } as Request)).toMatchObject(session);
    const altered = cookiePair.slice(0, -1) + (cookiePair.endsWith("A") ? "B" : "A");
    expect(getProductionSession({ headers: { cookie: altered } } as Request)).toBeNull();
    expect(getProductionSession({ headers: {} } as Request)).toBeNull();
  });
});

describe("disabled insecure development login", () => {
  it.each([ { email: "" }, { email: allowedEmail }, { email: "not-allowed@example.com" }])(
    "refuses email-only login without minting cookies", async (payload) => {
      const response = await requestApi("POST", "/api/auth/dev-login", payload);
      expect(response.status).toBe(403);
      expect(JSON.parse(response.body)).toEqual({ error: "Use verified Supabase Auth login." });
      expect(response.headers["set-cookie"]).toBeUndefined();
    },
  );
  it("does not expose configured DEV users", async () => {
    const response = await requestApi("GET", "/api/auth/dev-users");
    expect(response.status).toBe(404);
  });
});
