import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import express, { Router } from "express";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { registerPayrollProdConnectionPreflightRoutes } from "./payroll-prod-connection-preflight";

const state = vi.hoisted(() => ({
  role: "super_admin",
  actorId: "super_admin_test",
  actorEmail: "admin@example.test",
  actorCompanyId: 1,
  companyId: 1,
  identityRows: 1,
  identityError: false,
  identityCalls: 0,
  configured: true,
  configError: false,
  configReason: "secret:never-return-this",
  dbError: false,
  dbErrorCode: "",
  dbErrorMessage: "postgres://password@host/secret-database",
  dbRole: "bizportal_payroll_prod",
  scopedCompany: "1",
  calls: [] as Array<{ companyId: number; sql: string; values: unknown[] }>,
}));

vi.mock("@workspace/db", () => ({
  pool: {
    query: async (sql: string, values: unknown[]) => {
      state.identityCalls += 1;
      if (state.identityError) throw Error("private-postgres-error-password");
      if (!sql.includes("is_active IS TRUE") || !sql.includes("public.users") ||
          values[0] !== "google_103728868378401731050" ||
          values[1] !== "admcst001@gmail.com") throw Error("UNSAFE_IDENTITY_QUERY");
      return { rowCount: state.identityRows, rows: state.identityRows ? [{ "?column?": 1 }] : [] };
    },
  },
}));

vi.mock("./payroll-prod-db", () => ({
  payrollProdDedicatedRequired: () => {
    if (state.configError) throw Error(state.configReason);
    return state.configured;
  },
  payrollScopedQuery: async (companyId: number, sql: string, values: unknown[]) => {
    state.calls.push({ companyId, sql, values });
    if (state.dbError) throw Object.assign(new Error(state.dbErrorMessage), {code: state.dbErrorCode});
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
        payrollActor?: { id: string; email: string; role: string; companyId: number | null };
        payrollCompanyId?: number;
      };
      req.payrollActor = { role: state.role, id: state.actorId, email: state.actorEmail, companyId: state.actorCompanyId };
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
    state.actorId = "super_admin_test";
    state.actorEmail = "admin@example.test";
    state.actorCompanyId = 1;
    state.companyId = 1;
    state.identityRows = 1;
    state.identityError = false;
    state.identityCalls = 0;
    state.configured = true;
    state.configError = false;
    state.configReason = "secret:never-return-this";
    state.dbError = false;
    state.dbErrorCode = "";
    state.dbErrorMessage = "postgres://password@host/secret-database";
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

  it("rejects unrecognized Owner and other roles, without accessing DB", async () => {
    vi.stubEnv("APP_ENV", "production");
    for (const role of ["owner", "admin", "finance", "viewer"]) {
      state.role = role;
      const { response } = await request();
      expect(response.status).toBe(403);
    }
    expect(state.calls).toHaveLength(0);
    expect(state.identityCalls).toBe(0);
  });

  it("allows only the active designated CST Owner for read-only connection probe", async () => {
    vi.stubEnv("APP_ENV", "production");
    state.role = "owner";
    state.actorId = "google_103728868378401731050";
    state.actorEmail = "admcst001@gmail.com";
    const { response, body } = await request();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ready: true, readOnly: true, dedicatedConnectionVerified: true,
      canPay: false, canPostJournal: false,
    });
    expect(state.identityCalls).toBe(1);
    expect(state.calls).toHaveLength(1);
  });

  it("accepts signed session ID distinct from the designated public.users DB ID", async () => {
    vi.stubEnv("APP_ENV", "production");
    state.role = "owner";
    state.actorId = "unrelated-supabase-auth-sub";
    state.actorEmail = "admcst001@gmail.com";
    const { response } = await request();
    expect(response.status).toBe(200);
    expect(state.identityCalls).toBe(1);
    expect(state.calls).toHaveLength(1);
  });

  it("rejects revoked designated Owner without entering dedicated Payroll connection", async () => {
    vi.stubEnv("APP_ENV", "production");
    state.role = "owner";
    state.actorId = "google_103728868378401731050";
    state.actorEmail = "admcst001@gmail.com";
    state.identityRows = 0;
    const { response } = await request();
    expect(response.status).toBe(403);
    expect(state.identityCalls).toBe(1);
    expect(state.calls).toHaveLength(0);
  });

  it("rejects designated Owner for other company and actor tenant mismatch", async () => {
    vi.stubEnv("APP_ENV", "production");
    state.role = "owner";
    state.actorId = "google_103728868378401731050";
    state.actorEmail = "admcst001@gmail.com";
    for (const [scope, tenant] of [[2, 1], [1, 2]] as const) {
      state.companyId = scope;
      state.actorCompanyId = tenant;
      const { response } = await request();
      expect(response.status).toBe(403);
    }
    expect(state.identityCalls).toBe(0);
    expect(state.calls).toHaveLength(0);
  });

  it("does not allow other Owner email or a non-designated public.users ID", async () => {
    vi.stubEnv("APP_ENV", "production");
    state.role = "owner";
    state.actorId = "auth-session-id-not-equal-to-public-user-id";
    state.actorEmail = "other@example.test";
    expect((await request()).response.status).toBe(403);
    expect(state.identityCalls).toBe(0);
    state.actorEmail = "admcst001@gmail.com";
    // A valid Supabase session ID is not the same as the internal public.users row ID.
    // Access requires server-side active public.users row pinned by ID and email.
    state.identityRows = 0;
    expect((await request()).response.status).toBe(403);
    expect(state.identityCalls).toBe(1);
    expect(state.calls).toHaveLength(0);
  });

  it("does not leak database error if Owner revalidation fails", async () => {
    vi.stubEnv("APP_ENV", "production");
    state.role = "owner";
    state.actorId = "google_103728868378401731050";
    state.actorEmail = "admcst001@gmail.com";
    state.identityError = true;
    const { response, body } = await request();
    expect(response.status).toBe(503);
    expect(body.code).toBe("PAYROLL_PROD_OWNER_VERIFICATION_UNAVAILABLE");
    expect(JSON.stringify(body)).not.toContain("private-postgres-error-password");
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

  it("exposes allowlisted URL error codes only, without secrets", async () => {
    vi.stubEnv("APP_ENV", "production");
    const allowlist=[
      "PAYROLL_PROD_URL_MALFORMED",
      "PAYROLL_PROD_URL_SCHEME_INVALID",
      "PAYROLL_PROD_PROJECT_MISMATCH",
      "PAYROLL_PROD_USERNAME_MISMATCH",
      "PAYROLL_PROD_HOST_MISMATCH",
      "PAYROLL_PROD_POOLER_USERNAME_SUFFIX_REQUIRED",
      "PAYROLL_PROD_DATABASE_NAME_MISSING",
    ];
    state.configError=true;
    for(const reason of allowlist){
      state.configReason=reason;
      const {response,body}=await request();
      expect(response.status).toBe(503);
      expect(body.code).toBe("PAYROLL_PROD_DEDICATED_CONFIG_INVALID");
      expect(body.reasonCode).toBe(reason);
      expect(state.calls).toHaveLength(0);
    }
    state.configReason="postgres://secret-password@private-host-name";
    const {body}=await request();
    expect(body.reasonCode).toBe("PAYROLL_PROD_URL_MALFORMED");
    expect(JSON.stringify(body)).not.toContain("secret-password");
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


  it("classifies an actual PostgreSQL authentication error without exposing the supplied username", async () => {
    vi.stubEnv("APP_ENV", "production");
    state.dbError = true;
    state.dbErrorCode = "28P01";
    state.dbErrorMessage = 'password authentication failed for user "secret-login-name"';
    const {response,body} = await request();
    expect(response.status).toBe(503);
    expect(body.code).toBe("PAYROLL_PROD_DATABASE_READINESS_FAILED");
    expect(body.reasonCode).toBe("PAYROLL_PROD_DATABASE_PASSWORD_REJECTED");
    expect(JSON.stringify(body)).not.toContain("secret-login-name");
  });

  it("distinguishes a missing pooler tenant from a database role permission error", async () => {
    vi.stubEnv("APP_ENV", "production");
    state.dbError = true;
    state.dbErrorMessage = "FATAL: (ENOTFOUND) tenant/user missing";
    expect((await request()).body.reasonCode).toBe("PAYROLL_PROD_POOLER_ROUTING_FAILED");
    state.dbErrorMessage = 'permission denied to set role "bizportal_payroll_prod"';
    state.dbErrorCode = "42501";
    expect((await request()).body.reasonCode).toBe("PAYROLL_PROD_DATABASE_PERMISSION_DENIED");
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
