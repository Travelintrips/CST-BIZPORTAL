import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import express, { Router } from "express";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { registerPayrollProdConnectionPreflightRoutes } from "./payroll-prod-connection-preflight";

const state = vi.hoisted(() => ({
  role: "super_admin",
  companyId: 1,
  configured: true,
  configError: false,
  dbError: false,
  dbRole: "bizportal_payroll_prod",
  scopedCompany: "1",
  calls: [] as Array<{ companyId: number; sql: string; values: unknown[] }>,
}));

vi.mock("./payroll-prod-db", () => ({
  payrollProdDedicatedRequired: () => {
    if (state.configError) throw Error("secret:never-return-this");
    return state.configured;
  },
  payrollScopedQuery: async (companyId: number, sql: string, values: unknown[]) => {
    state.calls.push({ companyId, sql, values });
    if (state.dbError) throw Error("postgres://password@host/secret-database");
    return {
      rowCount: 1,
      rows: [{ dbRole: state.dbRole, companyScope: state.scopedCompany, visibleRuns: "1", visibleProfiles: "0" }],
    };
  },
}));

describe("Payroll PROD dedicated role and scoped connection preflight (read only)", () => {
  let server: Server;
  let root: string;

  beforeAll(async () => {
    const app = express();
    const router = Router();
    router.use((request, _response, next) => {
      const req = request as typeof request & {
        payrollActor?: { role: string };
        payrollCompanyId?: number;
      };
      req.payrollActor = { role: state.role };
      req.payrollCompanyId = state.companyId;
      next();
    });
    registerPayrollProdConnectionPreflightRoutes(router);
    app.use("/api", router);
    server = createServer(app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw Error("SERVER_PORT_MISSING");
    root = "http://127.0.0.1:" + address.port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    state.role = "super_admin";
    state.companyId = 1;
    state.configured = true;
    state.configError = false;
    state.dbError = false;
    state.dbRole = "bizportal_payroll_prod";
    state.scopedCompany = "1";
    state.calls.length = 0;
  });

  async function request() {
    const response = await fetch(root + "/api/payroll/connection-preflight");
    return { response, body: await response.json() as Record<string, unknown> };
  }

  it("never probes or exposes readiness outside PROD", async () => {
    vi.stubEnv("APP_ENV", "development");
    const { response } = await request();
    expect(response.status).toBe(404);
    expect(state.calls).toHaveLength(0);
  });

  it("rejects Owner and Admin even when PROD connection is configured", async () => {
    vi.stubEnv("APP_ENV", "production");
    for (const role of ["owner", "admin", "finance", "viewer"]) {
      state.role = role;
      const { response } = await request();
      expect(response.status).toBe(403);
    }
    expect(state.calls).toHaveLength(0);
  });

  it("does not touch database if dedicated connection is not configured", async () => {
    vi.stubEnv("APP_ENV", "production");
    state.configured = false;
    const { response, body } = await request();
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toMatchObject({
      ready: false,
      readOnly: true,
      dedicatedConnectionVerified: false,
      code: "PAYROLL_PROD_DEDICATED_NOT_CONFIGURED",
    });
    expect(state.calls).toHaveLength(0);
  });

  it("returns safe status for malformed connection configuration", async () => {
    vi.stubEnv("APP_ENV", "production");
    state.configError = true;
    const { response, body } = await request();
    expect(response.status).toBe(503);
    expect(JSON.stringify(body)).not.toContain("secret:never-return-this");
    expect(state.calls).toHaveLength(0);
  });

  it("rejects invalid company scope without a database call", async () => {
    vi.stubEnv("APP_ENV", "production");
    state.companyId = 0;
    const { response } = await request();
    expect(response.status).toBe(403);
    expect(state.calls).toHaveLength(0);
  });

  it("proves actual PROD DB role and tenant-scoped SELECT only", async () => {
    vi.stubEnv("APP_ENV", "production");
    const { response, body } = await request();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ready: true,
      readOnly: true,
      dedicatedConnectionVerified: true,
      companyScopeVerified: true,
      roleVerified: true,
      canPay: false,
      canPostJournal: false,
    });
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0]?.companyId).toBe(1);
    expect(state.calls[0]?.values).toEqual([]);
    expect(state.calls[0]?.sql).toContain("current_user");
    expect(state.calls[0]?.sql).toContain("public.payroll_runs");
    expect(state.calls[0]?.sql).toContain("public.payroll_salary_profiles");
    expect(state.calls[0]?.sql.toUpperCase()).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE)\b/);
    expect(JSON.stringify(body)).not.toContain("visibleRuns");
    expect(JSON.stringify(body)).not.toContain("visibleProfiles");
  });

  it("rejects a shared role even if its SELECT succeeds", async () => {
    vi.stubEnv("APP_ENV", "production");
    state.dbRole = "bizportal_prod";
    const { response, body } = await request();
    expect(response.status).toBe(503);
    expect(body.code).toBe("PAYROLL_PROD_ROLE_OR_SCOPE_INVALID");
  });

  it("rejects a cross-company or missing transaction-local scope", async () => {
    vi.stubEnv("APP_ENV", "production");
    for (const scope of ["2", ""]) {
      state.scopedCompany = scope;
      const { response, body } = await request();
      expect(response.status).toBe(503);
      expect(body.code).toBe("PAYROLL_PROD_ROLE_OR_SCOPE_INVALID");
    }
  });

  it("fails closed without leaking the connection string on DB failure", async () => {
    vi.stubEnv("APP_ENV", "production");
    state.dbError = true;
    const { response, body } = await request();
    expect(response.status).toBe(503);
    expect(JSON.stringify(body)).not.toContain("postgres://");
    expect(JSON.stringify(body)).not.toContain("secret-database");
  });
});
