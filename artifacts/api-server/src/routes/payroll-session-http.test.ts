import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import { once } from "node:events";

const state = vi.hoisted(() => ({
  environment: "development" as "development" | "production",
  productionSession: false,
  productionActor: null as null | { id: string; email: string; role: string; companyId: number | null; firstName: null; lastName: null },
  devActor: null as null | { id: string; email: string; role: string; companyId: number | null; firstName: null; lastName: null },
  queries: [] as Array<{ sql: string; args?: unknown[] }>,
}));
vi.mock("./dev-auth", () => ({
  isDevelopmentEnvironment: () => state.environment === "development",
  getProductionSession: () => state.productionSession ? { id: "session1", email: "official@example.test", issuedAt: 1, expiresAt: Date.now() + 10000 } : null,
  getProductionUser: async () => state.productionActor,
  getDevSession: () => state.devActor,
}));
vi.mock("@workspace/db", () => ({
  pool: {
    query: async (sql: string, args?: unknown[]) => {
      state.queries.push({ sql, args });
      if (sql.includes("FROM public.payroll_runs")) return { rows: [], rowCount: 0 };
      throw Error("Unexpected database access");
    },
  },
}));

describe("Payroll canonical DEV and PROD session", () => {
  let server: Server;
  let root: string;
  const official = { id: "u1", email: "official@example.test", role: "admin", companyId: 1, firstName: null, lastName: null };
  const dev = { id: "dev1", email: "dev@example.test", role: "admin", companyId: 1, firstName: null, lastName: null };
  beforeAll(async () => {
    const { default: router } = await import("./payroll");
    const app = express(); app.use(express.json()); app.use("/api", router);
    server = createServer(app); server.listen(0, "127.0.0.1"); await once(server, "listening");
    const addr = server.address(); if (!addr || typeof addr === "string") throw Error("Missing listener");
    root = `http://127.0.0.1:${addr.port}/api/payroll/runs?companyId=1`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
  });
  beforeEach(() => {
    state.environment = "development"; state.productionSession = false; state.productionActor = null;
    state.devActor = null; state.queries.length = 0;
  });
  afterEach(() => { state.devActor = null; });

  it("accepts official session in DEV", async () => {
    state.productionSession = true; state.productionActor = official;
    expect((await fetch(root)).status).toBe(200);
    expect(state.queries).toHaveLength(1);
  });
  it("keeps supported DEV-only session fallback", async () => {
    state.devActor = dev;
    expect((await fetch(root)).status).toBe(200);
  });
  it("rejects revoked official account without falling back to DEV cookie", async () => {
    state.productionSession = true; state.productionActor = null; state.devActor = dev;
    expect((await fetch(root)).status).toBe(401);
    expect(state.queries).toHaveLength(0);
  });
  it("never accepts DEV cookie in production", async () => {
    state.environment = "production"; state.devActor = dev;
    expect((await fetch(root)).status).toBe(401);
    expect(state.queries).toHaveLength(0);
  });
  it("enforces assigned company even with official session", async () => {
    state.productionSession = true; state.productionActor = official;
    expect((await fetch(root.replace("companyId=1", "companyId=2"))).status).toBe(403);
    expect(state.queries).toHaveLength(0);
  });
});
