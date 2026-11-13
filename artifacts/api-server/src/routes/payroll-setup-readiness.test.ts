import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express, { Router } from "express";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { registerPayrollSetupReadinessRoutes } from "./payroll-setup-readiness";

const state = vi.hoisted(() => ({
  role: "owner",
  companyId: 1,
  ready: true,
  throwDbError: false,
  calls: [] as Array<{companyId:number;sql:string;args:unknown[]}>,
}));
vi.mock("./payroll-prod-db", () => ({
  payrollReadOnlyReady: () => state.ready,
  payrollScopedQuery: async (companyId:number,sql:string,args:unknown[]) => {
    state.calls.push({companyId,sql,args});
    if (state.throwDbError) throw Error("postgresql://sensitive:password@do-not-reveal");
    const n = companyId === 1 ? 22 : companyId === 3 ? 1 : 0;
    return {rowCount:1,rows:[{
      employeeCount:n, salaryConfiguredCount:0, missingSalaryCount:n,
      deductionConfiguredCount:0, missingDeductionCount:n,
      invalidSalaryCount:0,invalidDeductionCount:0,readyEmployeeCount:0,
    }]};
  },
}));

describe("Payroll setup readiness via authenticated and company-scoped read-only route", () => {
  let server:Server,root:string;
  beforeAll(async () => {
    const router=Router();
    router.use((req,_res,next) => {
      const q=req as typeof req & {
        payrollActor?:{role:string};payrollCompanyId?:number
      };
      q.payrollActor={role:state.role};
      q.payrollCompanyId=state.companyId;
      next();
    });
    registerPayrollSetupReadinessRoutes(router);
    const app=express();
    app.use("/api",router);
    server=createServer(app);
    server.listen(0,"127.0.0.1");
    await once(server,"listening");
    const a=server.address();
    if(!a||typeof a==="string")throw Error("NO_SERVER_PORT");
    root="http://127.0.0.1:"+a.port;
  });
  afterAll(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));});
  beforeEach(()=>{
    vi.stubEnv("APP_ENV","production");
    state.role="owner";state.companyId=1;state.ready=true;state.throwDbError=false;
    state.calls.length=0;
  });
  const get=(year="2026",month="11")=>fetch(
    root+"/api/payroll/setup-readiness?companyId=99&year="+year+"&month="+month
  );
  it("returns only aggregate counts for CST using authenticated company, never user-supplied company",async()=>{
    const res=await get();expect(res.status).toBe(200);
    const data=await res.json();
    expect(data).toMatchObject({
      companyId:1,year:2026,month:11,effectiveThrough:"2026-11-30",
      employeeCount:22,salaryConfiguredCount:0,missingSalaryCount:22,
      deductionConfiguredCount:0,missingDeductionCount:22,
      readyEmployeeCount:0,dataComplete:false,canCreateDraft:false,
      canApprove:false,canPay:false,canPostJournal:false,readOnly:true,
    });
    expect(JSON.stringify(data)).not.toMatch(/baseSalary|employeeName|secret|password/i);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0]?.companyId).toBe(1);
    expect(state.calls[0]?.args).toEqual([1,"2026-11-30"]);
    expect(state.calls[0]?.sql).toContain("public.payroll_salary_profiles");
    expect(state.calls[0]?.sql).toContain("public.payroll_deduction_settings");
    expect(state.calls[0]?.sql).not.toMatch(/\\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE)\\b/i);
  });
  it("isolates a different company with a distinct employee count",async()=>{
    state.companyId=3;
    const data=await (await get("2026","12")).json();
    expect(data.companyId).toBe(3);
    expect(data.employeeCount).toBe(1);
    expect(data.effectiveThrough).toBe("2026-12-31");
    expect(state.calls[0]?.args).toEqual([3,"2026-12-31"]);
  });
  it("reports no readiness for a company with zero active employees",async()=>{
    state.companyId=2;
    const data=await (await get()).json();
    expect(data.employeeCount).toBe(0);
    expect(data.dataComplete).toBe(false);
  });
  it("blocks staff and finance without querying database",async()=>{
    for(const role of ["staff","finance","admin"]) {
      state.role=role;expect((await get()).status).toBe(403);
    }
    expect(state.calls).toHaveLength(0);
  });
  it("rejects invalid period and refuses queries in unconfigured or non-PROD environments",async()=>{
    for(const [y,m] of [["2026","13"],["0","11"],["2026","x"],["2100","11"]]) {
      expect((await get(y,m)).status).toBe(400);
    }
    expect(state.calls).toHaveLength(0);
    state.ready=false;
    expect((await get()).status).toBe(503);
    vi.stubEnv("APP_ENV","development");
    state.ready=true;
    expect((await get()).status).toBe(503);
    expect(state.calls).toHaveLength(0);
  });
  it("redacts raw database errors and does not claim readiness",async()=>{
    state.throwDbError=true;
    const res=await get();
    expect(res.status).toBe(503);
    const raw=await res.text();
    expect(raw).not.toContain("postgresql://");
    expect(raw).not.toContain("password");
  });
});
