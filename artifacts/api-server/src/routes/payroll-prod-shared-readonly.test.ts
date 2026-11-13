import { afterEach, describe, expect, it, vi } from "vitest";

const state=vi.hoisted(()=>({
  commands: [] as string[],
  releaseCount: 0,
  role: "bizportal_payroll_prod",
  company: "1",
}));
vi.mock("@workspace/db",()=>({
  createDedicatedPayrollPool: vi.fn(()=>{throw Error("DEDICATED_POOL_NOT_ALLOWED_IN_SHARED_MODE");}),
  pool:{
    connect: vi.fn(async()=>({
      query: async (sql:string, params?:unknown[])=>{
        state.commands.push(sql);
        if(sql==="SELECT current_user AS role, current_setting('app.payroll_company_id',true) AS company")
          return {rowCount:1, rows:[{role:state.role,company:state.company}]};
        if(sql==="SELECT 42 AS probe")
          return {rowCount:1,rows:[{probe:42}]};
        return {rowCount:1,rows:[]};
      },
      release:()=>{state.releaseCount++;}
    })),
  },
}));
import {
  payrollProdDedicatedRequired,
  payrollProdSharedReadOnlyEnabled,
  payrollReadOnlyReady,
  payrollScopedQuery,
  getPayrollPool,
} from "./payroll-prod-db";

describe("Payroll PROD uses existing authenticated BizPortal connection only in explicit read-only mode",()=>{
  afterEach(()=>{
    vi.unstubAllEnvs();
    state.commands.length=0;
    state.releaseCount=0;
    state.role="bizportal_payroll_prod";
    state.company="1";
  });
  const enable=()=>{
    vi.stubEnv("APP_ENV","production");
    vi.stubEnv("PAYROLL_PROD_SHARED_READONLY_ENABLED","true");
    vi.stubEnv("PAYROLL_PROD_REQUIRE_DEDICATED_DB","true");
    vi.stubEnv("PAYROLL_DATABASE_URL_PROD",
      "postgresql://bizportal_payroll_prod_login.nzdweipzckfszczzqtuw:wrong@aws-1-ap-southeast-2.pooler.supabase.com:5432/postgres?sslmode=require");
  };

  it("uses BEGIN READ ONLY, SET LOCAL ROLE, scoped company and COMMIT; never touches second password",async()=>{
    enable();
    expect(payrollProdSharedReadOnlyEnabled()).toBe(true);
    expect(payrollReadOnlyReady()).toBe(true);
    expect(payrollProdDedicatedRequired()).toBe(false);
    const res=await payrollScopedQuery(1,"SELECT 42 AS probe",[]);
    expect(res.rows[0].probe).toBe(42);
    expect(state.commands).toEqual([
      "BEGIN READ ONLY",
      "SET LOCAL ROLE bizportal_payroll_prod",
      "SELECT set_config('app.payroll_company_id',$1,true)",
      "SELECT current_user AS role, current_setting('app.payroll_company_id',true) AS company",
      "SELECT 42 AS probe",
      "COMMIT",
    ]);
    expect(state.releaseCount).toBe(1);
    expect(()=>getPayrollPool()).toThrow("PAYROLL_PROD_DEDICATED_DATABASE_REQUIRED");
  });

  it("ROLLBACK and deny access if the shared connection cannot assume restricted role",async()=>{
    enable();
    state.role="postgres";
    await expect(payrollScopedQuery(1,"SELECT 42 AS probe",[]))
      .rejects.toThrow("PAYROLL_SHARED_ROLE_OR_COMPANY_SCOPE_INVALID");
    expect(state.commands).toContain("ROLLBACK");
    expect(state.commands).not.toContain("SELECT 42 AS probe");
    expect(state.releaseCount).toBe(1);
  });

  it("ROLLBACK on company mismatch and invalid company fails before DB connection",async()=>{
    enable();
    state.company="2";
    await expect(payrollScopedQuery(1,"SELECT 42 AS probe",[]))
      .rejects.toThrow("PAYROLL_SHARED_ROLE_OR_COMPANY_SCOPE_INVALID");
    expect(state.commands).toContain("ROLLBACK");
    state.commands.length=0;
    await expect(payrollScopedQuery(0,"SELECT 42 AS probe",[]))
      .rejects.toThrow("PAYROLL_INVALID_COMPANY_SCOPE");
    expect(state.commands).toHaveLength(0);
  });

  it("does not silently enable shared read-only in DEV or without explicit opt-in",()=>{
    vi.stubEnv("APP_ENV","development");
    vi.stubEnv("PAYROLL_PROD_SHARED_READONLY_ENABLED","true");
    expect(payrollProdSharedReadOnlyEnabled()).toBe(false);
    vi.stubEnv("APP_ENV","production");
    vi.stubEnv("PAYROLL_PROD_SHARED_READONLY_ENABLED","");
    expect(payrollProdSharedReadOnlyEnabled()).toBe(false);
  });
});
