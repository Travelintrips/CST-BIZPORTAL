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
    const companyRows=state.rows.filter(r=>r.company_id===companyId);
    if(sql.includes("AS verified_count")) {
      const pending=companyRows.filter(r=>Number(r.remaining_amount)>0);
      return{rowCount:1,rows:[{verified_count:"0",verified_amount:"0",
        pending_count:String(pending.length),
        pending_amount:String(pending.reduce((n,r)=>n+Number(r.remaining_amount),0))}]};
    }
    if(sql.includes("AND a.id=$2")) {
      const rows=companyRows.filter(r=>r.id===values[1]);
      return{rowCount:rows.length,rows};
    }
    const filtered=companyRows.filter(r=>
      (!values[1] || (r.status.toLowerCase()==="draft"?"draft":r.lifecycle_status.toLowerCase())===values[1]) &&
      (!values[2] || r.employee_name.toLowerCase().includes(String(values[2]))) &&
      (!values[3] || r.advance_date>=String(values[3])) &&
      (!values[4] || r.advance_date<=String(values[4]))
    );
    if(sql.includes("count(*)::text AS total"))return{rowCount:1,rows:[{total:String(filtered.length)}]};
    const limit=Number(values[5]),offset=Number(values[6]);
    const rows=filtered.slice(offset,offset+limit);
    return{rowCount:rows.length,rows};
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
    expect(state.queries).toHaveLength(2);
    expect(state.queries[0].sql).toContain("count(*)::text AS total");
    expect(state.queries[1]).toMatchObject({companyId:1,values:[1,"","",null,null,50,0]});
    expect(state.queries[1].sql).toContain("a.company_id=$1 AND a.type='kasbon'");
    expect(state.queries[1].sql).toContain("LIMIT $6 OFFSET $7");
    expect(state.queries[1].sql).not.toMatch(/LIMIT 2000/);
    expect(state.queries[1].sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
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
  it("paginates and filters in SQL without truncating historical records",async()=>{
    const r=await get("/advances?companyId=1&page=2&limit=1&party_name=andi");
    expect(r.status).toBe(200);
    const body=await r.json() as Record<string,any>;
    expect(body.total).toBe(2);
    expect(body.data).toHaveLength(1);
    expect(state.queries[0].sql).toContain("count(*)::text AS total");
    expect(state.queries[1].values).toEqual([1,"","andi",null,null,1,1]);
  });
  it("aggregates full company scope without LIMIT and fetches detail directly",async()=>{
    await get("/advances/dashboard?companyId=1");
    expect(state.queries).toHaveLength(1);
    expect(state.queries[0].sql).toContain("sum(remaining_amount)");
    expect(state.queries[0].sql).not.toMatch(/LIMIT/);
    state.queries.length=0;
    await get("/advances/39?companyId=1");
    expect(state.queries).toHaveLength(1);
    expect(state.queries[0].sql).toContain("AND a.id=$2");
    expect(state.queries[0].values).toEqual([1,39]);
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