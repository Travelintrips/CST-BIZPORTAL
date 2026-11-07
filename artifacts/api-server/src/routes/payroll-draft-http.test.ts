import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import { once } from "node:events";

const state = vi.hoisted(() => ({
  actor: { id: "dev-admin", email: "dev@example.test", role: "admin", companyId: null as number | null, firstName: null, lastName: null },
  existing: false,
  calls: [] as Array<{ sql: string; values: unknown[] | undefined }>,
  released: 0,
}));
vi.mock("./dev-auth", () => ({
  isDevelopmentEnvironment: () => true,
  getDevSession: () => state.actor,
  getProductionSession: () => null,
  getProductionUser: async () => null,
}));
vi.mock("@workspace/db", () => ({
  pool: {
    connect: async () => ({
      query: async (sql: string, values?: unknown[]) => {
        state.calls.push({ sql, values });
        if (sql.startsWith("SELECT id FROM")) return state.existing
          ? { rows: [{ id: 99 }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
        if (sql.startsWith("INSERT INTO")) return {
          rows: [{ id: 101, company_id: values?.[0], month: values?.[1], year: values?.[2], status: "draft", posting_status: "pending", accounting_entry_id: null, payment_entry_id: null }],
          rowCount: 1,
        };
        return { rows: [], rowCount: 0 };
      },
      release: () => { state.released++; },
    }),
    query: async () => { throw new Error("Unexpected pool query"); },
  },
}));

describe("DEV payroll draft HTTP guard", () => {
  let server: Server;
  let root: string;
  beforeAll(async () => {
    const { default: payrollRouter } = await import("./payroll");
    const app = express();
    app.use(express.json());
    app.use("/api", payrollRouter);
    server = createServer(app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No address");
    root = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  });
  beforeEach(() => {
    state.actor.role = "admin";
    state.actor.companyId = null;
    state.existing = false;
    state.calls.length = 0;
    state.released = 0;
    delete process.env.PAYROLL_DEV_DRAFT_ENABLED;
  });
  afterEach(() => { delete process.env.PAYROLL_DEV_DRAFT_ENABLED; });

  async function create(body: unknown, company = "1") {
    return fetch(root + "/api/payroll/runs?companyId=" + company, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
  }

  it("is disabled by default with no SQL executed", async () => {
    const response = await create({ month: 11, year: 2026 });
    expect(response.status).toBe(501);
    expect(state.calls).toHaveLength(0);
  });

  it("refuses invalid period and non-payroll managers", async () => {
    process.env.PAYROLL_DEV_DRAFT_ENABLED = "true";
    expect((await create({ month: 13, year: 2026 })).status).toBe(400);
    state.actor.role = "finance";
    state.actor.companyId = 1;
    expect((await create({ month: 11, year: 2026 })).status).toBe(403);
    expect(state.calls).toHaveLength(0);
  });

  it("serializes same-company same-period creation and returns only a draft", async () => {
    process.env.PAYROLL_DEV_DRAFT_ENABLED = "true";
    const response = await create({ month: 11, year: 2026 });
    expect(response.status).toBe(201);
    const payload = await response.json() as { run: { companyId: number; month: number; year: number; status: string } };
    expect(payload.run).toMatchObject({ companyId: 1, month: 11, year: 2026, status: "draft" });
    expect(state.calls.map((c) => c.sql.trim().split(" ")[0])).toEqual([
      "BEGIN", "SELECT", "SELECT", "INSERT", "COMMIT",
    ]);
    expect(state.calls[1]?.values).toEqual([1, 202611]);
    expect(state.released).toBe(1);
    expect(state.calls.some((c) => /journal|payroll_items|cash_advances/i.test(c.sql))).toBe(false);
  });

  it("rejects duplicate periods after lock and rolls back without inserting", async () => {
    process.env.PAYROLL_DEV_DRAFT_ENABLED = "true";
    state.existing = true;
    const response = await create({ month: 11, year: 2026 });
    expect(response.status).toBe(409);
    expect(state.calls.some((c) => c.sql.startsWith("INSERT INTO"))).toBe(false);
    expect(state.calls.at(-1)?.sql).toBe("ROLLBACK");
    expect(state.released).toBe(1);
  });
});
