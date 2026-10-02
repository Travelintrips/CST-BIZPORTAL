import http from "node:http";
import express, { type Express } from "express";
import { hash } from "bcryptjs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { queryMock, sendEmailMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  sendEmailMock: vi.fn(),
}));

vi.mock("@workspace/db", () => ({
  pool: { query: queryMock },
}));

vi.mock("../lib/smtp", () => ({
  sendAdminLoginOtpEmail: sendEmailMock,
}));

type TestResponse = {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: unknown;
};

function request(
  server: http.Server,
  path: string,
  body: unknown,
): Promise<TestResponse> {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server is not listening");
  const payload = JSON.stringify(body);

  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port: address.port,
      path,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
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
    req.end(payload);
  });
}

describe("local production email OTP authentication", () => {
  let app: Express;
  let server: http.Server;
  let localProductionAuthRouter: typeof import("./local-production-auth").default;
  let otpHash: string;
  let activeUser = true;
  let activeRole = "admin";
  let recentRequestCount = 0;
  let otpAttempts = 0;

  beforeAll(async () => {
    process.env.APP_ENV = "production";
    process.env.NODE_ENV = "production";
    process.env.SESSION_SECRET = "local-email-otp-test-session-secret-32-bytes";
    otpHash = await hash("123456", 4);
    ({ default: localProductionAuthRouter } = await import("./local-production-auth"));
  });

  beforeEach(async () => {
    activeUser = true;
    activeRole = "admin";
    recentRequestCount = 0;
    otpAttempts = 0;
    queryMock.mockReset();
    sendEmailMock.mockReset();
    sendEmailMock.mockResolvedValue(undefined);
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("create table") || sql.includes("create index")) return { rows: [] };
      if (sql.includes("count(*)::text")) return { rows: [{ count: String(recentRequestCount) }] };
      if (sql.includes("code_hash, attempts")) {
        return {
          rows: [{
            id: "otp-1",
            code_hash: otpHash,
            attempts: otpAttempts,
            expires_at: new Date(Date.now() + 5 * 60 * 1000),
          }],
        };
      }
      if (sql.includes("with invalidated")) return { rows: [{ id: "otp-1" }] };
      if (sql.includes("returning id")) return { rowCount: 1, rows: [{ id: "otp-1" }] };
      if (sql.includes("set attempts = attempts + 1")) {
        otpAttempts += 1;
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("to_jsonb(u)")) {
        return {
          rows: activeUser ? [{
            user_data: {
              id: "admin-1",
              email: "admin@example.com",
              role: activeRole,
              status: "active",
              is_active: true,
              company_id: 1,
            },
          }] : [],
        };
      }
      return { rows: [] };
    });

    app = express();
    app.use(express.json());
    app.use(localProductionAuthRouter);
    server = await new Promise<http.Server>((resolve) => {
      const listeningServer = app.listen(0, "127.0.0.1", () => resolve(listeningServer));
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  it("keeps owner password login available through the production session path", async () => {
    const password = "owner-password";
    const passwordHash = await hash(password, 4);
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("to_jsonb(u)")) {
        return {
          rows: [{
            user_data: {
              id: "owner-1",
              email: "owner@example.com",
              role: "owner",
              status: "active",
              is_active: true,
              company_id: 1,
              password_hash: passwordHash,
            },
          }],
        };
      }
      return { rows: [] };
    });

    const response = await request(server, "/auth/email-login", {
      email: "owner@example.com",
      password,
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      user: { email: "owner@example.com", role: "owner", companyId: 1 },
    });
    expect(response.headers["set-cookie"]?.[0]).toContain("bizportal_supabase_session=");
  });

  it("returns the same generic response for an unknown email without sending", async () => {
    activeUser = false;
    const response = await request(server, "/auth/email-otp/send", { email: "unknown@example.com" });

    expect(response.status).toBe(202);
    expect(response.body).toEqual({
      ok: true,
      message: "Jika email admin terdaftar, kode OTP akan dikirim.",
    });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("sends only a hashed six-digit OTP for an active admin", async () => {
    const response = await request(server, "/auth/email-otp/send", { email: "Admin@Example.com" });

    expect(response.status).toBe(202);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const [recipient, code] = sendEmailMock.mock.calls[0] as [string, string];
    expect(recipient).toBe("admin@example.com");
    expect(code).toMatch(/^\d{6}$/);
    expect(queryMock.mock.calls.some(([sql]) => String(sql).includes("code_hash"))).toBe(true);
    const insertCall = queryMock.mock.calls.find(([sql]) => String(sql).includes("with invalidated"));
    expect(insertCall).toBeDefined();
    expect(String(insertCall?.[0])).toContain("values ($1, $2, $3, $4, $5)");
    expect(insertCall?.[1]?.[2]).toBe("admin-email-login");
  });

  it("creates the secure local session after one correct verification", async () => {
    await request(server, "/auth/email-otp/send", { email: "admin@example.com" });
    const response = await request(server, "/auth/email-otp/verify", {
      email: "admin@example.com",
      code: "123456",
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      user: { email: "admin@example.com", role: "admin" },
    });
    const cookie = response.headers["set-cookie"]?.[0] ?? "";
    expect(cookie).toContain("bizportal_supabase_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
  });

  it("allows an active owner to use email OTP as a recovery login path", async () => {
    activeRole = "owner";

    const sendResponse = await request(server, "/auth/email-otp/send", {
      email: "admin@example.com",
    });
    expect(sendResponse.status).toBe(202);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);

    const verifyResponse = await request(server, "/auth/email-otp/verify", {
      email: "admin@example.com",
      code: "123456",
    });
    expect(verifyResponse.status).toBe(200);
    expect(verifyResponse.body).toMatchObject({
      ok: true,
      user: { email: "admin@example.com", role: "owner" },
    });
  });

  it("does not send when the email/IP rate limit is reached", async () => {
    recentRequestCount = 3;
    const response = await request(server, "/auth/email-otp/send", { email: "admin@example.com" });

    expect(response.status).toBe(202);
    expect(response.body).toEqual({
      ok: true,
      message: "Jika email admin terdaftar, kode OTP akan dikirim.",
    });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("rejects a wrong code without revealing account state", async () => {
    const response = await request(server, "/auth/email-otp/verify", {
      email: "admin@example.com",
      code: "654321",
    });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: "Email atau kode OTP tidak dapat digunakan.",
    });
    expect(otpAttempts).toBe(1);
  });
});