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
  body: unknown;
}

function request(server: http.Server, path: string, cookie: string): Promise<TestResponse> {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server is not listening");

  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port: address.port,
      path,
      method: "GET",
      headers: { cookie },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: res.statusCode ?? 0,
          body: text ? JSON.parse(text) : null,
        });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function makeDevelopmentCookie(): string {
  const payload = Buffer.from(JSON.stringify({
    id: "dev-admin",
    email: "admin@example.com",
    firstName: "Admin",
    lastName: null,
    role: "admin",
    companyId: null,
    issuedAt: Date.now(),
    expiresAt: Date.now() + 3600_000,
  })).toString("base64url");
  const signature = crypto
    .createHmac("sha256", process.env.SESSION_SECRET!)
    .update(payload)
    .digest("base64url");
  return `bizportal_dev_session=${payload}.${signature}`;
}

describe("vendor invoice detail read path", () => {
  let purchaseWorkflowRouter: typeof import("./purchase-workflow").default;
  let server: http.Server;
  let app: Express;

  beforeAll(async () => {
    process.env.APP_ENV = "development";
    process.env.NODE_ENV = "development";
    process.env.SESSION_SECRET = "vendor-invoice-detail-test-secret-at-least-32-bytes";
    process.env.DEV_LOGIN_EMAILS = "admin@example.com";
    ({ default: purchaseWorkflowRouter } = await import("./purchase-workflow"));

    app = express();
    app.use(express.json());
    app.use(purchaseWorkflowRouter);
    app.get("/purchase-workflow/vendor-invoices/liability-accounts", (_req, res) => {
      res.json([{ id: 501, code: "2-1000", name: "Utang PPh" }]);
    });
    app.get("/purchase-workflow/vendor-invoices/:id", (req, res) => {
      res.json({
        id: Number(req.params.id),
        status: "posted",
        withholdingTaxAmount: "0",
        lineTaxes: [],
        withholdingRecords: [],
      });
    });
    server = await new Promise<http.Server>((resolve) => {
      const listeningServer = app.listen(0, "127.0.0.1", () => resolve(listeningServer));
    });
  });

  beforeEach(() => {
    queryMock.mockReset();
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });

  it.each([9, 12])("returns invoice #%s with zero PPh and no withholding records on repeated reads", async (id) => {
    const cookie = makeDevelopmentCookie();
    const first = await request(server, `/purchase-workflow/vendor-invoices/${id}?company=1`, cookie);
    const second = await request(server, `/purchase-workflow/vendor-invoices/${id}?company=1`, cookie);

    for (const response of [first, second]) {
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        id,
        status: "posted",
        withholdingTaxAmount: "0",
        lineTaxes: [],
        withholdingRecords: [],
      });
    }

    expect(queryMock).not.toHaveBeenCalled();
  });

  it("passes liability-account reads upstream without querying the local database", async () => {
    const response = await request(
      server,
      "/purchase-workflow/vendor-invoices/liability-accounts?company=1",
      makeDevelopmentCookie(),
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual([{ id: 501, code: "2-1000", name: "Utang PPh" }]);
    expect(queryMock).not.toHaveBeenCalled();
  });
});