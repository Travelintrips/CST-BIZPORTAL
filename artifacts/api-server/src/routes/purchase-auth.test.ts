import crypto from "node:crypto";
import http from "node:http";
import express, { type Express } from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();

vi.mock("@workspace/db", () => ({
  pool: {
    query: queryMock,
  },
}));

interface TestResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

function request(
  server: http.Server,
  path: string,
  options: {
    method?: string;
    body?: unknown;
    cookie?: string;
  } = {},
): Promise<TestResponse> {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server is not listening");
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);

  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port: address.port,
      path,
      method: options.method ?? "GET",
      headers: {
        ...(body ? {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        } : {}),
        ...(options.cookie ? { cookie: options.cookie } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: text ? JSON.parse(text) : null,
        });
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}

function makeSupabaseToken(method: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + 3600,
    amr: [{ method }],
  })).toString("base64url");
  return `${header}.${payload}.signature`;
}

function makeProductionCookie(email: string): string {
  const session = {
    id: "auth-user-id",
    email,
    issuedAt: Date.now(),
    expiresAt: Date.now() + 3600_000,
  };
  const payload = Buffer.from(JSON.stringify(session)).toString("base64url");
  const signature = crypto
    .createHmac("sha256", process.env.SESSION_SECRET!)
    .update(payload)
    .digest("base64url");
  return `bizportal_supabase_session=${payload}.${signature}`;
}

function mockUser(role: string) {
  queryMock.mockResolvedValue({
    rows: [{
      user_data: {
        email: "admin@example.com",
        role,
        company_id: 1,
      },
    }],
  });
}

describe("production purchase authentication", () => {
  let createDevAuthRouter: typeof import("./dev-auth").createDevAuthRouter;
  let purchaseWorkflowRouter: typeof import("./purchase-workflow").default;
  let server: http.Server;
  let app: Express;
  const originalFetch = global.fetch;

  beforeAll(async () => {
    process.env.APP_ENV = "production";
    process.env.NODE_ENV = "production";
    process.env.SESSION_SECRET = "purchase-auth-test-secret-at-least-32-bytes";
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.VITE_SUPABASE_ANON_KEY = "test-anon-key";

    ({ createDevAuthRouter } = await import("./dev-auth"));
    ({ default: purchaseWorkflowRouter } = await import("./purchase-workflow"));

    app = express();
    app.use(express.json());
    app.use(createDevAuthRouter({
      onProductionLogin: async (_token, _user, response) => {
        response.append(
          "Set-Cookie",
          "bizportal_upstream_session=upstream; Path=/; HttpOnly; Secure",
        );
      },
    }));
    app.use(purchaseWorkflowRouter);
    app.use((_req, res) => res.status(204).end());
    server = await new Promise<http.Server>((resolve) => {
      const listeningServer = app.listen(0, "127.0.0.1", () => resolve(listeningServer));
    });
  });

  beforeEach(() => {
    queryMock.mockReset();
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: "auth-user-id",
      email: "admin@example.com",
    }), { status: 200 }));
  });

  afterAll(async () => {
    global.fetch = originalFetch;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });

  it("does not apply purchase authorization to unrelated routes", async () => {
    const response = await request(server, "/users/me");
    expect(response.status).toBe(204);
  });

  it("returns 401 for an anonymous proxied purchase route", async () => {
    const response = await request(server, "/purchase-workflow/proxied-handler");
    expect(response.status).toBe(401);
  });

  it("returns 403 for a signed session whose database role is not admin", async () => {
    mockUser("finance");
    const response = await request(server, "/purchase-workflow/proxied-handler", {
      cookie: makeProductionCookie("admin@example.com"),
    });
    expect(response.status).toBe(403);
  });

  it("serves vendor-invoice detail locally after auth", async () => {
    queryMock
      .mockResolvedValueOnce({
        rows: [{
          user_data: {
            email: "admin@example.com",
            role: "admin",
            company_id: 1,
          },
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 12,
          company_id: 1,
          invoice_number: "VI/2026/00004",
          status: "posted",
          grand_total: "26852296",
          reconciled_amount_paid: "0",
          withholding_tax_amount: "0",
          withholding_tax_type: null,
          invoice_breakdown: {
            totals: { gross: 26852296, payable_amount: 26852296 },
            components: [],
          },
          updated_at: new Date("2026-09-17T00:00:00.000Z"),
        }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const response = await request(server, "/purchase-workflow/vendor-invoices/12?company=1", {
      cookie: makeProductionCookie("admin@example.com"),
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      id: 12,
      status: "posted",
      withholdingTaxAmount: "0",
      lineTaxes: [],
      withholdingRecords: [],
    });
    expect(queryMock).toHaveBeenCalledTimes(5);
  });

  it("rejects a non-OTP token without issuing a cookie", async () => {
    const response = await request(server, "/auth/supabase-exchange", {
      method: "POST",
      body: { access_token: makeSupabaseToken("password") },
    });
    expect(response.status).toBe(401);
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  it("rejects a non-admin without issuing a cookie", async () => {
    mockUser("finance");
    const response = await request(server, "/auth/supabase-exchange", {
      method: "POST",
      body: { access_token: makeSupabaseToken("otp") },
    });
    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      error: "Email atau kode OTP tidak dapat digunakan untuk login admin.",
    });
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  it("issues both local and upstream cookies to an OTP-authenticated admin", async () => {
    mockUser("admin");
    const response = await request(server, "/auth/supabase-exchange", {
      method: "POST",
      body: { access_token: makeSupabaseToken("otp") },
    });
    expect(response.status).toBe(200);
    expect(response.headers["set-cookie"]).toEqual(expect.arrayContaining([
      expect.stringContaining("bizportal_upstream_session="),
      expect.stringContaining("bizportal_supabase_session="),
    ]));
  });
});