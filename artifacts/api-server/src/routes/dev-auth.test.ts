import { EventEmitter } from "node:events";
import http, {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
} from "node:http";
import { type AddressInfo } from "node:net";
import https from "node:https";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../app";

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

describe("development login bridge", () => {
  it.each([
    ["404", { kind: "response", statusCode: 404 } as const],
    ["5xx", { kind: "response", statusCode: 503 } as const],
    ["transport errors", { kind: "transport-error" } as const],
  ])("creates a local session when the optional upstream returns %s", async (_label, behavior) => {
    mockUpstreamLogin(behavior);

    const loginResponse = await requestApi("POST", "/api/auth/dev-login", {
      email: allowedEmail,
    });

    expect(loginResponse.status).toBe(200);
    expect(JSON.parse(loginResponse.body)).toMatchObject({
      user: { email: allowedEmail },
    });

    const setCookie = loginResponse.headers["set-cookie"]?.[0];
    expect(setCookie).toMatch(/^bizportal_dev_session=[^;]+;/);

    const sessionCookie = setCookie?.split(";", 1)[0];
    const userResponse = await requestApi("GET", "/api/auth/user", undefined, sessionCookie);
    expect(userResponse.status).toBe(200);
    expect(JSON.parse(userResponse.body)).toMatchObject({
      user: { email: allowedEmail },
    });
  });

  it("blocks an unauthorized upstream response instead of creating a local session", async () => {
    const upstreamRequest = mockUpstreamLogin({
      kind: "response",
      statusCode: 401,
    });

    const loginResponse = await requestApi("POST", "/api/auth/dev-login", {
      email: allowedEmail,
    });

    expect(loginResponse.status).toBe(502);
    expect(JSON.parse(loginResponse.body)).toEqual({
      error: "Development API login is unavailable",
    });
    expect(loginResponse.headers["set-cookie"]).toBeUndefined();
    expect(upstreamRequest).toHaveBeenCalledOnce();
  });

  it("blocks an email that is not on the development allowlist", async () => {
    const upstreamRequest = mockUpstreamLogin({
      kind: "response",
      statusCode: 200,
    });

    const loginResponse = await requestApi("POST", "/api/auth/dev-login", {
      email: "not-allowed@example.com",
    });

    expect(loginResponse.status).toBe(403);
    expect(JSON.parse(loginResponse.body)).toEqual({
      error: "Email belum diizinkan untuk Dev Login.",
    });
    expect(loginResponse.headers["set-cookie"]).toBeUndefined();
    expect(upstreamRequest).not.toHaveBeenCalled();
  });
});