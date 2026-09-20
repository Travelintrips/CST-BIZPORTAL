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
    queryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("from public.audit_logs")) {
        const auditEvents = [
          {
            id: 101,
            company_id: 1,
            entity_id: "12",
            user_email: "finance@example.com",
            created_at: new Date("2026-09-17T08:30:00.000Z"),
            before_data: {
              reason: "Header PPh perlu dipisahkan",
              rows: [
                {
                  invoice_line_id: "77",
                  tax_type: "PPh 23",
                  tax_object: "Jasa",
                  base_amount: "1000.456",
                  tax_amount: "20.129",
                  liability_account_id: "501",
                  line_tax_id: "900",
                  resolution_status: "pending",
                },
              ],
            },
            after_data: {
              reason: "Baris PPh dipisahkan berdasarkan jenis pajak",
              rows: [
                {
                  invoiceLineId: 77,
                  taxType: "PPh 23",
                  taxObject: "Jasa",
                  baseAmount: "1000.46",
                  taxAmount: "20.13",
                  liabilityAccountId: 501,
                  lineTaxId: 900,
                  resolutionStatus: "confirmed",
                },
              ],
            },
          },
          {
            id: 202,
            company_id: 2,
            entity_id: "12",
            user_email: "other-company@example.com",
            created_at: new Date("2026-09-17T09:00:00.000Z"),
            before_data: { rows: [] },
            after_data: { reason: "Perusahaan lain", rows: [] },
          },
          {
            id: 303,
            company_id: 1,
            entity_id: "99",
            user_email: "other-invoice@example.com",
            created_at: new Date("2026-09-17T09:30:00.000Z"),
            before_data: { rows: [] },
            after_data: { reason: "Invoice lain", rows: [] },
          },
        ];
        return {
          rows: auditEvents.filter((event) =>
            event.company_id === params?.[0] && event.entity_id === params?.[1]),
        };
      }
      if (sql.includes("from public.vendor_invoices vi") && sql.includes("count(*) over()")) {
        return {
          rows: [{
            id: 12,
            company_id: 1,
            invoice_number: "VI/2026/00004",
            vendor_invoice_ref: "AP-00004",
            supplier_name: "PT. ANGKASA PURA INDONESIA",
            status: "posted",
            grand_total: "26852296",
            reconciled_amount_paid: "0",
            three_way_match_status: "unmatched",
            invoice_date: new Date("2026-09-17T00:00:00.000Z"),
            journal_entry_id: 44,
            journal_status: "posted",
            withholding_tax_amount: "537045.92",
            withholding_tax_type: "PPh 23",
            invoice_breakdown: {
              totals: { withholding_tax_amount: 537045.92, payable_amount: 26315250.08 },
              components: [{
                withholding_tax_type: "PPh 23",
                withholding_tax_amount: 537045.92,
              }],
            },
            pph_paid_amount: "137045.92",
            total_count: 1,
          }],
        };
      }
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

  it("returns PPh amount and breakdown on the AP list projection", async () => {
    const response = await request(
      server,
      "/purchase-workflow/vendor-invoices?company=1&page=1&pageSize=50",
      makeDevelopmentCookie(),
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      total: 1,
      data: [{
        id: 12,
        invoiceNumber: "VI/2026/00004",
        grandTotal: 26852296,
        withholdingTaxAmount: "537045.92",
        withholdingTaxType: "PPh 23",
        invoiceBreakdown: {
          totals: {
            withholding_tax_amount: 537045.92,
            payable_amount: 26315250.08,
          },
        },
        pphPaidAmount: 137045.92,
      }],
    });

    const listSql = String(queryMock.mock.calls[0]?.[0] ?? "");
    expect(listSql).toContain("vi.withholding_tax_amount");
    expect(listSql).toContain("vi.withholding_tax_type");
    expect(listSql).toContain("vi.invoice_breakdown");
    expect(listSql).toContain("bdi.transaction_type = 'tax_payment'");
    expect(listSql).toContain("bdi.vendor_invoice_id = vi.id");
    expect(listSql).toContain("bd.status = 'posted'");
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

  it("returns only the active company's invoice history with normalized rows", async () => {
    const response = await request(
      server,
      "/purchase-workflow/vendor-invoices/12/legacy-withholding-repair-history?company=1",
      makeDevelopmentCookie(),
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      data: [{
        id: 101,
        actor: "finance@example.com",
        timestamp: "2026-09-17T08:30:00.000Z",
        reason: "Baris PPh dipisahkan berdasarkan jenis pajak",
        beforeRows: [{
          invoiceLineId: 77,
          taxType: "PPh 23",
          taxObject: "Jasa",
          baseAmount: 1000.46,
          taxAmount: 20.13,
          liabilityAccountId: 501,
          lineTaxId: 900,
          resolutionStatus: "pending",
        }],
        afterRows: [{
          invoiceLineId: 77,
          taxType: "PPh 23",
          taxObject: "Jasa",
          baseAmount: 1000.46,
          taxAmount: 20.13,
          liabilityAccountId: 501,
          lineTaxId: 900,
          resolutionStatus: "confirmed",
        }],
      }],
      total: 1,
    });
    const historyBody = response.body as { data: unknown[] };
    expect(historyBody.data).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 202, actor: "other-company@example.com" }),
    ]));

    expect(queryMock).toHaveBeenCalledTimes(1);
    const [historySql, historyParams] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(historySql).toMatch(/where\s+company_id\s*=\s*\$1/i);
    expect(historySql).toMatch(/entity_id\s*=\s*\$2/i);
    expect(historySql).toMatch(/action\s*=\s*'repair_legacy_withholding'/i);
    expect(historyParams).toEqual([1, "12"]);
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