import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from "vitest";
import express from "express";
import {createServer,type Server} from "node:http";
import {once} from "node:events";

const state=vi.hoisted(()=>({
  role:"owner",companyId:1,actorEnabled:true,sessionEnabled:true,readerReady:true,readFailure:false,
  queries:[] as Array<{companyId:number;sql:string;values:unknown[]}>,
  rows:[
    {id:22,company_id:1,employee_id:38,advance_number:"KSB-20260701-35C2F38B",
      advance_date:"2026-07-01",amount:"21000000.00",remaining_amount:"11000000.00",
      settled_amount:"0.00",paid_amount:"10000000.00",status:"partial",
      lifecycle_status:"partially_settled",posting_status:"PENDING",approved_at:null,
      approved_by:null,disbursed_at:null,disbursed_by:null,accounting_entry_id:null,
      voided_at:null,employee_name:"Andi Wangsamas"},
    {id:39,company_id:1,employee_id:38,advance_number:"KSB-20260802-0E264D14",
      advance_date:"2026-08-02",amount:"5000000.00",remaining_amount:"5000000.00",
      settled_amount:"0.00",paid_amount:"0.00",status:"DRAFT",
      lifecycle_status:"outstanding",posting_status:"PENDING",approved_at:null,
      approved_by:null,disbursed_at:null,disbursed_by:null,accounting_entry_id:null,
      voided_at:null,employee_name:"Andi Wangsamas"},
  ],
}));
vi.mock("./dev-auth",()=>({
  getProductionSession:()=>state.sessionEnabled?{id:"mock-session"}:null,
  getProductionUser:async()=>state.actorEnabled?
    {id:"owner",email:"owner@example.test",role:state.role,companyId:state.companyId}:null,
}));
vi.mock("./payroll-prod-db",()=>({
  payrollReadOnlyReady:()=>state.readerReady,
  payrollScopedQuery:async(companyId:number,sql:string,values:unknown[])=>{
    state.queries.push({companyId,sql,values});
    if(state.readFailure)throw Error("PASSWORD=EXAMPLE_SECRET");
    return{rowCount:state.rows.length,rows:state.rows};
  },
}));
import router from "./advance-kasbon-readonly";
describe("Standalone Advance canonical read-only employee kasbon visibility",()=>{
  let server:Server,root:string;
  beforeAll(async()=>{
    const app=express();app.use("/api",router);
    server=createServer(app);server.listen(0,"127.0.0.1");await once(server,"listening");
    const addr=server.address();if(!addr||typeof addr==="string")throw Error("NO_PORT");
    root="http://127.0.0.1:"+addr.port;
  });
  afterAll(async()=>await new Promise<void>(resolve=>server.close(()=>resolve())));
  beforeEach(()=>{
    vi.stubEnv("APP_ENV","production");
    state.role="owner";state.companyId=1;state.actorEnabled=true;
    state.sessionEnabled=true;state.readerReady=true;state.readFailure=false;
    state.queries.length=0;
  });
  afterEach(()=>vi.unstubAllEnvs());
  const get=(path="/advances?companyId=1")=>fetch(root+"/api"+path);
  it("shows Andi historical Kasbon records as unverified rather than showing 0",async()=>{
    const response=await get("/advances?companyId=1&page=1&limit=50");
    expect(response.status).toBe(200);
    const body=await response.json() as Record<string,any>;
    expect(body).toMatchObject({
      total:2,companyId:1,coverage:"EMPLOYEE_KASBON_ONLY",readOnly:true,
      canCreate:false,canApprove:false,canDisburse:false,canRepay:false,
      canVoid:false,canPostJournal:false,
    });
    expect(body.data).toHaveLength(2);
    expect(body.data[0]).toMatchObject({
      advance_number:"KSB-20260701-35C2F38B",
      party_name:"Andi Wangsamas",amount:21000000,remaining_amount:11000000,
      verified_disbursement:false,requires_source_review:true,
    });
    expect(body.data[1]).toMatchObject({
      advance_number:"KSB-20260802-0E264D14",
      lifecycle_status:"draft",amount:5000000,remaining_amount:5000000,
      verified_disbursement:false,requires_source_review:true,
    });
    expect(state.queries).toHaveLength(1);
    expect(state.queries[0]).toMatchObject({companyId:1,values:[1]});
    expect(state.queries[0].sql).toContain("a.company_id=$1 AND a.type='kasbon'");
    expect(state.queries[0].sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
  });
  it("dashboard distinguishes recorded but unverified balance from verified debt",async()=>{
    const r=await get("/advances/dashboard?companyId=1");
    expect(r.status).toBe(200);
    const body=await r.json() as Record<string,any>;
    expect(body.stats).toMatchObject({
      recorded_unverified_count:2,recorded_unverified_amount:16000000,
      outstanding_count:0,outstanding_amount:0,total_remaining:0
    });
    expect(body.readOnly).toBe(true);
  });
  it("detail returns original reference but no financial writer capability",async()=>{
    const r=await get("/advances/39?companyId=1");
    expect(r.status).toBe(200);
    const body=await r.json() as Record<string,any>;
    expect(body).toMatchObject({
      advance_number:"KSB-20260802-0E264D14",readOnly:true,
      financialActionsDisabled:true,verified_disbursement:false,
    });
    expect((await get("/advances/9999?companyId=1")).status).toBe(404);
  });
  it("denies missing session and unauthorized actor with no DB query",async()=>{
    state.sessionEnabled=false;
    expect((await get()).status).toBe(401);
    state.sessionEnabled=true;state.actorEnabled=false;
    expect((await get()).status).toBe(403);
    expect(state.queries).toHaveLength(0);
  });
  it("denies cross-company, missing tenant and role outside finance",async()=>{
    state.companyId=3;state.role="finance";
    expect((await get()).status).toBe(403);
    state.companyId=1;state.role="staff";
    expect((await get()).status).toBe(403);
    state.role="owner";
    expect((await get("/advances")).status).toBe(403);
    expect(state.queries).toHaveLength(0);
  });
  it("fails closed without dedicated reader or in DEV",async()=>{
    state.readerReady=false;
    expect((await get()).status).toBe(503);
    vi.stubEnv("APP_ENV","development");state.readerReady=true;
    expect((await get()).status).toBe(503);
    expect(state.queries).toHaveLength(0);
  });
  it("refuses other advance categories rather than displaying fabricated zero rows",async()=>{
    const r=await get("/advances?companyId=1&advance_type=VENDOR");
    expect(r.status).toBe(422);
    expect(state.queries).toHaveLength(0);
  });
  it("redacts database errors and never falls back to empty balance",async()=>{
    state.readFailure=true;
    const r=await get();expect(r.status).toBe(503);
    const t=await r.text();expect(t).not.toContain("EXAMPLE_SECRET");
    expect(t).toMatch(/Bukan berarti saldo kasbon Rp0/);
  });
  it("rejects unsupported write methods",async()=>{
    const r=await fetch(root+"/api/advances?companyId=1",{
      method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});
    expect([404,405]).toContain(r.status);
    expect(state.queries).toHaveLength(0);
  });
});