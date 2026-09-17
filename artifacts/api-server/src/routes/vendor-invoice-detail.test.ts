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
    server = await new Promise<http.Server>((resolve) => {
      const listeningServer = app.listen(0, "127.0.0.1", () => resolve(listeningServer));
    });
  });

  beforeEach(() => {
    queryMock.mockReset();
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("from public.vendor_invoices vi")) {
        return {
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
        };
      }
      if (sql.includes("from public.vendor_invoice_lines")) return { rows: [] };
      if (sql.includes("from public.vendor_invoice_line_taxes")) return { rows: [] };
      if (sql.includes("from public.vendor_withholding_records")) return { rows: [] };
      if (sql.includes("from public.chart_of_accounts")) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });

  it("returns the canonical local invoice without invoking the upstream fallback", async () => {
    const cookie = makeDevelopmentCookie();
    const first = await request(server, "/purchase-workflow/vendor-invoices/12?company=1", cookie);
    const second = await request(server, "/purchase-workflow/vendor-invoices/12?company=1", cookie);

    for (const response of [first, second]) {
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        id: 12,
        status: "posted",
        withholdingTaxAmount: "0",
        lineTaxes: [],
        withholdingRecords: [],
      });
    }

    expect(queryMock).toHaveBeenCalled();
    expect(queryMock.mock.calls.every(([sql]) => !String(sql).match(/\b(insert|update|delete)\b/i))).toBe(true);
  });

  it("serves liability-account reads locally without forwarding them upstream", async () => {
    const response = await request(
      server,
      "/purchase-workflow/vendor-invoices/liability-accounts?company=1",
      makeDevelopmentCookie(),
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual([]);
    expect(queryMock).toHaveBeenCalled();
    const liabilityAccountSql = String(
      queryMock.mock.calls.find(([sql]) => String(sql).includes("from public.chart_of_accounts"))?.[0] ?? "",
    );
    expect(liabilityAccountSql).toMatch(/account_type::text[\s\S]*=\s*'liability'/i);
    expect(liabilityAccountSql).toMatch(/or\s+lower\(coalesce\(type::text[\s\S]*=\s*'liability'/i);
    expect(queryMock.mock.calls.every(([sql]) => !String(sql).match(/\b(insert|update|delete)\b/i))).toBe(true);
  });
});