import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import { once } from "node:events";

const mock = vi.hoisted(() => ({
  role: "admin", companyId: null as number | null, exists: true, status: "draft",
  invalid: 0, added: 2, queries: [] as string[], released: 0,
}));
vi.mock("./dev-auth", () => ({
  isDevelopmentEnvironment: () => true,
  getDevSession: () => ({ id: "dev", email: "test@example.test", firstName: null, lastName: null, role: mock.role, companyId: mock.companyId }),
  getProductionSession: () => null,
  getProductionUser: async () => null,
}));
vi.mock("@workspace/db", () => ({
  pool: {
    connect: async () => ({
      query: async (sql: string) => {
        mock.queries.push(sql);
        if (sql.includes("FROM public.payroll_runs WHERE id =")) return mock.exists
          ? { rowCount: 1, rows: [{ id: 20, status: mock.status }] }
          : { rowCount: 0, rows: [] };
        if (sql.includes("invalid_count FROM public.employees")) return { rowCount: 1, rows: [{ invalid_count: mock.invalid }] };
        if (sql.startsWith("INSERT INTO public.payroll_items")) return { rowCount: mock.added, rows: Array.from({ length: mock.added }, (_, i) => ({ id: i + 1 })) };
        return { rowCount: 0, rows: [] };
      },
      release: () => { mock.released++; },
    }),
    query: async () => { throw new Error("Unexpected pool query"); },
  },
}));

describe("DEV payroll generation", () => {
  let server: Server, base: string;
  beforeAll(async () => {
    const { default: router } = await import("./payroll");
    const app = express(); app.use(express.json()); app.use("/api", router);
    server = createServer(app); server.listen(0, "127.0.0.1"); await once(server, "listening");
    const addr = server.address(); if (!addr || typeof addr === "string") throw Error("No port");
    base = `http://127.0.0.1:${addr.port}/api/payroll/runs/20/generate-items?companyId=1`;
  });
  afterAll(async () => { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); });
  beforeEach(() => {
    mock.role = "admin"; mock.companyId = null; mock.exists = true; mock.status = "draft";
    mock.invalid = 0; mock.added = 2; mock.queries = []; mock.released = 0;
    delete process.env.PAYROLL_DEV_GENERATE_ENABLED;
  });
  afterEach(() => { delete process.env.PAYROLL_DEV_GENERATE_ENABLED; });
  const send = () => fetch(base, { method: "POST" });

  it("defaults closed without SQL", async () => {
    expect((await send()).status).toBe(501);
    expect(mock.queries).toHaveLength(0);
  });
  it("rejects finance even with flag", async () => {
    process.env.PAYROLL_DEV_GENERATE_ENABLED = "true"; mock.role = "finance"; mock.companyId = 1;
    expect((await send()).status).toBe(403);
    expect(mock.queries).toHaveLength(0);
  });
  it("rejects foreign or non-draft run and releases lock", async () => {
    process.env.PAYROLL_DEV_GENERATE_ENABLED = "true";
    mock.exists = false;
    expect((await send()).status).toBe(404);
    expect(mock.queries.some(q => q.startsWith("INSERT"))).toBe(false);
    mock.queries = []; mock.exists = true; mock.status = "approved";
    expect((await send()).status).toBe(409);
    expect(mock.queries.some(q => q.startsWith("INSERT"))).toBe(false);
    expect(mock.released).toBe(2);
  });
  it("fails atomically when active employee salary is missing", async () => {
    process.env.PAYROLL_DEV_GENERATE_ENABLED = "true"; mock.invalid = 1;
    expect((await send()).status).toBe(409);
    expect(mock.queries.some(q => q.startsWith("INSERT"))).toBe(false);
    expect(mock.queries.at(-1)).toBe("ROLLBACK");
  });
  it("only inserts missing scoped employees in draft without touching accounting", async () => {
    process.env.PAYROLL_DEV_GENERATE_ENABLED = "true";
    const response = await send();
    expect(response.status).toBe(200);
    expect((await response.json() as { added: number; companyId: number }).added).toBe(2);
    const sql = mock.queries.join("\n");
    expect(sql).toContain("e.company_id = $2");
    expect(sql).toContain("NOT EXISTS");
    expect(sql).toContain("FOR UPDATE");
    expect(mock.queries.some(q => /^\\s*(?:UPDATE|DELETE)\\s/i.test(q))).toBe(false);
    expect(sql).not.toMatch(/accounting_entries|cash_advances|salary_payments/);
    expect(mock.queries.at(-1)).toBe("COMMIT");
    expect(mock.released).toBe(1);
  });
});
