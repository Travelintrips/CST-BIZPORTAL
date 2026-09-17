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

function mockInvoice(id: number) {
  return {
    id,
    invoice_number: `VI/2026/${String(id).padStart(5, "0")}`,
    vendor_invoice_ref: `REF-${id}`,
    company_id: 1,
    supplier_id: 10,
    supplier_name: "PT Test Supplier",
    status: "posted",
    invoice_date: "2026-09-01",
    due_date: "2026-10-01",
    payment_term_days: 30,
    total_amount: "1000000",
    tax_amount: "110000",
    grand_total: "1110000",
    withholding_tax_amount: "0",
    withholding_tax_type: null,
    invoice_breakdown: null,
    reconciled_amount_paid: "0",
    three_way_match_status: "matched",
    match_notes: null,
    po_id: null,
    gr_id: null,
    journal_entry_id: 100 + id,
    journal_status: "posted",
    journal_entry_number: `JE-${id}`,
  };
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
      if (sql.includes("select vi.*")) {
        const id = sql.includes("where vi.id = $2") ? Number(queryMock.mock.calls.at(-1)?.[1]?.[1]) : 0;
        return { rows: [mockInvoice(id)] };
      }
      if (sql.includes("from public.vendor_invoice_lines")) {
        return { rows: [] };
      }
      if (sql.includes("from public.vendor_invoice_line_taxes")) {
        return { rows: [] };
      }
      if (sql.includes("from public.vendor_withholding_records")) {
        return { rows: [] };
      }
      throw new Error(`Unexpected read query: ${sql}`);
    });
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

    const sql = queryMock.mock.calls.map(([query]) => String(query));
    expect(sql.some((query) => /\b(insert|update|delete|begin|commit|rollback)\b/i.test(query))).toBe(false);
  });
});