import express, { type NextFunction, type Request, type Response } from "express";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();

vi.mock("@workspace/db", () => ({
  pool: { query },
}));

vi.mock("../routes/dev-auth", () => ({
  isDevelopmentEnvironment: () => true,
  getDevSession: () => ({
    id: 7,
    email: "finance@example.test",
    role: "finance",
    companyId: 11,
  }),
  getProductionSession: () => null,
  getProductionUser: async () => null,
}));

let app: express.Express;

beforeAll(async () => {
  const { default: accountingRouter } = await import("../routes/accounting");
  app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { log: { error: ReturnType<typeof vi.fn> } }).log = { error: vi.fn() };
    next();
  });
  app.use("/api", accountingRouter);
});

beforeEach(() => query.mockReset());
afterEach(() => vi.clearAllMocks());

async function get(path: string) {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`);
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

describe("GET /api/accounting/entries/:id", () => {
  it("returns company-scoped header totals with hydrated canonical lines", async () => {
    query
      .mockResolvedValueOnce({
        rows: [{ id: 42, status: "posted", ref: "BANK-42", total_debit: "125000.50", total_credit: "125000.50" }],
      })
      .mockResolvedValueOnce({
        rows: [
          { id: 1, account_id: 101, account_code: "1101", account_name: "Bank", debit: "125000.50", credit: "0", description: "Receipt" },
          { id: 2, account_id: 401, account_code: "4101", account_name: "Revenue", debit: "0", credit: "125000.50", description: "Revenue" },
        ],
      });

    const response = await get("/api/accounting/entries/42");

    expect(response.status).toBe(200);
    expect(query).toHaveBeenNthCalledWith(1, expect.stringContaining("and ($2::int is null or company_id = $2)"), [42, 11]);
    expect(query).toHaveBeenNthCalledWith(2, expect.stringContaining("from public.accounting_entry_lines l"), [42]);
    expect(response.body).toEqual({
      id: 42,
      status: "posted",
      ref: "BANK-42",
      totalDebit: 125000.5,
      totalCredit: 125000.5,
      lines: [
        { id: 1, accountId: 101, accountCode: "1101", accountName: "Bank", debit: "125000.50", credit: "0", description: "Receipt" },
        { id: 2, accountId: 401, accountCode: "4101", accountName: "Revenue", debit: "0", credit: "125000.50", description: "Revenue" },
      ],
    });
  });

  it("rejects an invalid journal id without querying the database", async () => {
    const response = await get("/api/accounting/entries/not-a-number");
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "ID jurnal tidak valid" });
    expect(query).not.toHaveBeenCalled();
  });

  it("returns 404 for a journal missing inside the authenticated company scope", async () => {
    query.mockResolvedValueOnce({ rows: [] });

    const response = await get("/api/accounting/entries/999");

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "Jurnal tidak ditemukan" });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("and ($2::int is null or company_id = $2)"), [999, 11]);
  });
});
