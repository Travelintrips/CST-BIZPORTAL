import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express,{Router} from "express";
import {createServer,type Server} from "node:http";
import {once} from "node:events";
import {registerPayrollHistoricalSalaryReviewRoutes} from "./payroll-historical-salary-review";

const state=vi.hoisted(()=>({
  role:"owner",companyId:1,ready:true,dbError:false,
  rows:[
    {id:101,firstName:"QA",lastName:"Historical",sourceRunId:31,
     sourceYear:2026,sourceMonth:6,sourceBaseSalary:"3000000.00",historicalKasbon:"100000.00",savedEffectiveFrom:null},
    {id:102,firstName:"QA",lastName:"Missing",sourceRunId:null,
     sourceYear:null,sourceMonth:null,sourceBaseSalary:null,historicalKasbon:null,savedEffectiveFrom:null},
    {id:103,firstName:"QA",lastName:"Configured",sourceRunId:31,
     sourceYear:2026,sourceMonth:6,sourceBaseSalary:"2000000.00",historicalKasbon:"0.00",savedEffectiveFrom:"2026-07-01"},
  ],
  calls:[] as Array<{companyId:number;sql:string;values:unknown[]}>,
}));
vi.mock("./payroll-prod-db",()=>({
  payrollReadOnlyReady:()=>state.ready,
  payrollScopedQuery:async(companyId:number,sql:string,values:unknown[])=>{
    state.calls.push({companyId,sql,values});
    if(state.dbError)throw Error("postgresql://secret-login:secret-password@private-db");
    return {rowCount:state.rows.length,rows:state.rows};
  },
}));

describe("historical payroll salary suggestions, authenticated read-only",()=>{
  let server:Server,root:string;
  beforeAll(async()=>{
    const router=Router();
    router.use((req,_res,next)=>{
      const scoped=req as typeof req&{payrollActor?:{role:string};payrollCompanyId?:number};
      scoped.payrollActor={role:state.role};
      scoped.payrollCompanyId=state.companyId;
      next();
    });
    registerPayrollHistoricalSalaryReviewRoutes(router);
    const app=express();app.use("/api",router);
    server=createServer(app);server.listen(0,"127.0.0.1");await once(server,"listening");
    const a=server.address();if(!a||typeof a==="string")throw Error("NO_PORT");
    root="http://127.0.0.1:"+a.port;
  });
  afterAll(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));});
  beforeEach(()=>{
    vi.stubEnv("APP_ENV","production");
    state.role="owner";state.companyId=1;state.ready=true;state.dbError=false;
    state.calls.length=0;
  });
  const get=(year="2026",month="11")=>fetch(
    root+"/api/payroll/historical-salary-review?companyId=999&year="+year+"&month="+month
  );
  it("shows confirmed historical salary as candidate only, no kasbon transfer or approval",async()=>{
    const r=await get();expect(r.status).toBe(200);
    const data=await r.json() as Record<string,any>;
    expect(data).toMatchObject({
      companyId:1,year:2026,month:11,effectiveThrough:"2026-11-30",
      sourcePolicy:"APPROVED_AND_POSTED_BEFORE_TARGET_MONTH",
      summary:{employeeCount:3,candidatesNeedingHrConfirmation:1,
        noHistoricalSource:1,alreadyConfigured:1,historicalKasbonNeedsReview:1},
      reviewRequired:true,canBulkImport:false,canApply:false,canPay:false,
      canPostJournal:false,readOnly:true,
    });
    expect(data.rows[0]).toMatchObject({
      employeeId:101,employeeName:"QA Historical",
      sourceRunId:31,sourceYear:2026,sourceMonth:6,
      proposedBaseSalary:"3000000.00",
      historicalKasbonNeedsReview:true,status:"NEEDS_HR_CONFIRMATION"
    });
    expect(data.rows[1]).toMatchObject({employeeId:102,proposedBaseSalary:null,status:"NO_HISTORICAL_SOURCE"});
    expect(data.rows[2]).toMatchObject({employeeId:103,status:"ALREADY_CONFIGURED"});
    expect(JSON.stringify(data)).not.toContain('"historicalKasbon":"100000.00"');
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0]?.companyId).toBe(1);
    expect(state.calls[0]?.values).toEqual([1,2026,11,"2026-11-30"]);
    expect(state.calls[0]?.sql).toContain("r.status='approved'");
    expect(state.calls[0]?.sql).toContain("r.posting_status='posted'");
    expect(state.calls[0]?.sql).not.toMatch(/employees\.salary|\bINSERT\b|\bUPDATE\b|\bDELETE\b/i);
  });
  it("uses authenticated company, not caller supplied companyId",async()=>{
    state.companyId=3;
    const data=await (await get()).json() as Record<string,any>;
    expect(data.companyId).toBe(3);
    expect(state.calls[0]?.companyId).toBe(3);
    expect(state.calls[0]?.values).toEqual([3,2026,11,"2026-11-30"]);
  });
  it("denies admin/finance/staff without any database access",async()=>{
    for(const role of ["admin","finance","staff","viewer"]){
      state.role=role;
      expect((await get()).status).toBe(403);
    }
    expect(state.calls).toHaveLength(0);
  });
  it("rejects bad dates, disabled reader, or development mode",async()=>{
    for(const [y,m] of [["bad","11"],["2026","13"],["2100","11"],["2026","0"]]){
      expect((await get(y,m)).status).toBe(400);
    }
    expect(state.calls).toHaveLength(0);
    state.ready=false;expect((await get()).status).toBe(503);
    vi.stubEnv("APP_ENV","development");state.ready=true;
    expect((await get()).status).toBe(503);
  });
  it("redacts SQL errors and never claims review is applied",async()=>{
    state.dbError=true;const r=await get();
    expect(r.status).toBe(503);const t=await r.text();
    expect(t).not.toContain("secret-login");
    expect(t).not.toContain("secret-password");
    expect(t).not.toContain("postgresql://");
  });
});
