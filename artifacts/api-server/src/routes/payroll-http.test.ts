import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import { once } from "node:events";

const state = vi.hoisted(() => ({
  actor: null as null | { id: string; email: string; role: string; companyId: number | null; firstName: string | null; lastName: string | null },
  queries: [] as Array<{ text: string; values: unknown[] }>,
}));

vi.mock("./dev-auth", () => ({
  isDevelopmentEnvironment: () => true,
  getDevSession: () => state.actor,
  getProductionSession: () => null,
  getProductionUser: async () => null,
}));

vi.mock("@workspace/db", () => ({
  pool: {
    query: async (text: string, values: unknown[]) => {
      state.queries.push({ text, values });
      if (text.includes("FROM public.payroll_runs") && text.includes("AND id = $2")) {
        return Number(values[1]) === 8 && Number(values[0]) === 1
          ? { rows: [{ id: 8, company_id: 1, month: 11, year: 2026, status: "draft" }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (text.includes("FROM public.payroll_runs")) return {
        rows: [{ id: 8, company_id: Number(values[0]), month: 11, year: 2026, status: "draft" }],
        rowCount: 1,
      };
      if (text.includes("FROM public.payroll_items")) return { rows: [], rowCount: 0 };
      throw new Error("Unexpected SQL");
    },
  },
}));

describe("payroll HTTP isolation", () => {
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
    if (!address || typeof address === "string") throw new Error("Missing HTTP port");
    root = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  beforeEach(() => {
    state.actor = null;
    state.queries.length = 0;
  });

  it("rejects requests without session before querying payroll", async () => {
    const response = await fetch(root + "/api/payroll/runs?companyId=1");
    expect(response.status).toBe(401);
    expect(state.queries).toHaveLength(0);
  });

  it("rejects consolidated and cross-company selection", async () => {
    state.actor = { id: "u1", email: "user@example.test", role: "finance", companyId: 1, firstName: null, lastName: null };
    for (const companyId of ["all", "2"]) {
      const response = await fetch(root + "/api/payroll/runs?companyId=" + companyId);
      expect(response.status).toBe(403);
    }
    expect(state.queries).toHaveLength(0);
  });

  it("filters list and detail by company, and prevents foreign run enumeration", async () => {
    state.actor = { id: "u1", email: "user@example.test", role: "finance", companyId: 1, firstName: null, lastName: null };
    const list = await fetch(root + "/api/payroll/runs?companyId=1");
    expect(list.status).toBe(200);
    expect(((await list.json()) as { runs: Array<{ companyId: number }> }).runs[0].companyId).toBe(1);
    const foreign = await fetch(root + "/api/payroll/runs/9?companyId=1");
    expect(foreign.status).toBe(404);
    const own = await fetch(root + "/api/payroll/runs/8?companyId=1");
    expect(own.status).toBe(200);
    expect(((await own.json()) as { run: { companyId: number } }).run.companyId).toBe(1);
    expect(state.queries.every((query) => Number(query.values[0]) === 1)).toBe(true);
  });

  it("refuses financial writes even for a privileged actor", async () => {
    state.actor = { id: "u1", email: "user@example.test", role: "owner", companyId: 1, firstName: null, lastName: null };
    for (const suffix of ["", "/8/generate-items", "/8/calculate", "/8/approve", "/8/pay"]) {
      const response = await fetch(root + "/api/payroll/runs" + suffix + "?companyId=1", { method: "POST" });
      expect([404, 501]).toContain(response.status);
    }
    expect(state.queries).toHaveLength(0);
  });
});
