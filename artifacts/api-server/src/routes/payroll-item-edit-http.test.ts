import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import { once } from "node:events";

const mock = vi.hoisted(() => ({
  actor: { role: "admin", companyId: null as number | null },
  queries: [] as Array<{ sql: string; values?: unknown[] }>,
  exists: true, status: "draft", itemExists: true, released: 0,
}));
vi.mock("./dev-auth", () => ({
  isDevelopmentEnvironment: () => true,
  getDevSession: () => ({ ...mock.actor, id: "test", email: "test@example.test", firstName: null, lastName: null }),
  getProductionSession: () => null,
  getProductionUser: async () => null,
}));
vi.mock("@workspace/db", () => ({
  pool: {
    connect: async () => ({
      query: async (sql: string, values?: unknown[]) => {
        mock.queries.push({ sql, values });
        if (sql.includes("FROM public.payroll_runs WHERE company_id")) return mock.exists
          ? { rowCount: 1, rows: [{ id: 7, status: mock.status }] }
          : { rowCount: 0, rows: [] };
        if (sql.includes("FROM public.payroll_items pi")) return mock.itemExists
          ? { rowCount: 1, rows: [{
            id: 12, base_salary: "5000000", allowance: "0", bpjs_jht_employee: "0",
            bpjs_kes_employee: "0", pph21: "0", other_deductions: "0", kasbon_deduction: "100000",
          }] }
          : { rowCount: 0, rows: [] };
        if (sql.startsWith("UPDATE public.payroll_items")) return {
          rowCount: 1, rows: [{ id: 12, gross_salary: values?.[6], total_deductions: values?.[7], net_salary: values?.[8] }],
        };
        return { rowCount: 0, rows: [] };
      },
      release: () => { mock.released++; },
    }),
    query: async () => { throw Error("Unexpected pool query"); },
  },
}));

describe("DEV payroll salary editing HTTP", () => {
  let server: Server, url: string;
  beforeAll(async () => {
    const { default: router } = await import("./payroll");
    const app = express(); app.use(express.json()); app.use("/api", router);
    server = createServer(app); server.listen(0, "127.0.0.1"); await once(server, "listening");
    const addr = server.address(); if (!addr || typeof addr === "string") throw Error("port unavailable");
    url = `http://127.0.0.1:${addr.port}/api/payroll/runs/7/items/12?companyId=1`;
  });
  afterAll(async () => { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); });
  beforeEach(() => {
    mock.actor.role = "admin"; mock.actor.companyId = null;
    mock.queries.length = 0; mock.exists = true; mock.status = "draft"; mock.itemExists = true; mock.released = 0;
    delete process.env.PAYROLL_DEV_ITEM_EDIT_ENABLED;
  });
  afterEach(() => { delete process.env.PAYROLL_DEV_ITEM_EDIT_ENABLED; });
  const send = (body: unknown, path = url) => fetch(path, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });

  it("defaults closed with no database access", async () => {
    expect((await send({ allowance: 250000 })).status).toBe(501);
    expect(mock.queries).toHaveLength(0);
  });

  it("blocks finance and foreign company", async () => {
    process.env.PAYROLL_DEV_ITEM_EDIT_ENABLED = "true";
    mock.actor.role = "finance"; mock.actor.companyId = 1;
    expect((await send({ allowance: 250000 })).status).toBe(403);
    mock.actor.role = "admin"; mock.actor.companyId = 1;
    expect((await send({ allowance: 250000 }, url.replace("companyId=1", "companyId=2"))).status).toBe(403);
    expect(mock.queries).toHaveLength(0);
  });

  it("rejects illicit cash advance edits and invalid monetary values", async () => {
    process.env.PAYROLL_DEV_ITEM_EDIT_ENABLED = "true";
    for (const bad of [{ kasbonDeduction: 0 }, { allowance: -1 }, { allowance: 0.001 }, { otherDeductions: "1e9" }, {}]) {
      expect((await send(bad)).status).toBe(400);
    }
    expect(mock.queries).toHaveLength(0);
  });

  it("rejects non-draft and cross-company item IDs without UPDATE", async () => {
    process.env.PAYROLL_DEV_ITEM_EDIT_ENABLED = "true";
    mock.status = "approved";
    expect((await send({ allowance: 300000 })).status).toBe(409);
    mock.status = "draft"; mock.itemExists = false;
    expect((await send({ allowance: 300000 })).status).toBe(404);
    expect(mock.queries.some(q => q.sql.startsWith("UPDATE"))).toBe(false);
    expect(mock.released).toBe(2);
  });

  it("updates only payroll item amounts and recalculates gross/net without touching kasbon", async () => {
    process.env.PAYROLL_DEV_ITEM_EDIT_ENABLED = "true";
    const response = await send({ allowance: 400000, pph21: 50000 });
    expect(response.status).toBe(200);
    const payload = await response.json() as { item: { net_salary: number } };
    expect(payload.item.net_salary).toBe(5_250_000);
    const update = mock.queries.find(q => q.sql.startsWith("UPDATE public.payroll_items"));
    expect(update?.values?.slice(6, 9)).toEqual([5_400_000, 150_000, 5_250_000]);
    expect(mock.queries.some(q => /(?:^|\n)\s*(?:DELETE|INSERT|UPDATE public.cash_advances|UPDATE public.accounting)/i.test(q.sql))).toBe(false);
    expect(mock.queries.at(-1)?.sql).toBe("COMMIT");
    expect(mock.released).toBe(1);
  });

  it("refuses deductions exceeding gross and rolls back", async () => {
    process.env.PAYROLL_DEV_ITEM_EDIT_ENABLED = "true";
    expect((await send({ baseSalary: 100000, otherDeductions: 1000000 })).status).toBe(409);
    expect(mock.queries.some(q => q.sql.startsWith("UPDATE"))).toBe(false);
    expect(mock.queries.at(-1)?.sql).toBe("ROLLBACK");
  });
});
