import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express,{Router} from "express";
import {createServer,type Server} from "node:http";
import {once} from "node:events";
import {registerHrdEmployeeStatusRoutes} from "./hrd-employee-status";

const state=vi.hoisted(()=>({
  companyId:1,employeeStatus:"active",employeeId:61,
  auditFail:false,auditRows:0,commits:0,rollbacks:0,
  commands:[] as Array<{sql:string;values:unknown[]}>,
}));
vi.mock("./hrd-db",()=>({
  withHrdCompanyScope:async(companyId:number,work:(client:unknown)=>Promise<unknown>)=>{
    const original=state.employeeStatus;
    const beforeAudit=state.auditRows;
    try{
      const result=await work({
        query:async(sql:string,values:unknown[]=[])=>{
          state.commands.push({sql,values});
          if(sql.includes("FROM public.employees")&&sql.includes("FOR UPDATE")) {
            return companyId===1&&state.companyId===1
              ?{rowCount:1,rows:[{id:61,status:state.employeeStatus}]}
              :{rowCount:0,rows:[]};
          }
          if(sql.includes("UPDATE public.employees SET status='inactive'")){
            if(state.employeeStatus!=="active")return{rowCount:0,rows:[]};
            state.employeeStatus="inactive";
            return{rowCount:1,rows:[{id:61,status:"inactive"}]};
          }
          if(sql.includes("INSERT INTO hrd_private.employee_status_audit")){
            if(state.auditFail)throw Error("SIMULATED_ATOMIC_AUDIT_FAILURE");
            state.auditRows++;
            return{rowCount:1,rows:[{id:7}]};
          }
          if(sql.includes("SELECT id FROM public.employees")){
            return{rowCount:1,rows:[{id:61}]};
          }
          if(sql.includes("FROM hrd_private.employee_status_audit")){
            return{rowCount:state.auditRows,rows:state.auditRows?[{
              previousStatus:"active",status:"inactive",reason:"surat resign terkonfirmasi HRD",
              changedBy:"owner@example.test",changedAt:"2026-11-14T00:00:00Z",
            }]:[]};
          }
          throw Error("Unexpected SQL");
        }
      });
      state.commits++;return result;
    }catch(e){
      state.employeeStatus=original;
      state.auditRows=beforeAudit;
      state.rollbacks++;throw e;
    }
  }
}));
describe("HRD scoped and audited resign / inactive transition",()=>{
  let server:Server,root:string;
  beforeAll(async()=>{
    const router=Router();
    router.use((req,_res,next)=>{
      const q=req as typeof req&{hrdCompanyId?:number;hrdActor?:{email:string;role:string}};
      q.hrdCompanyId=state.companyId;
      q.hrdActor={email:"owner@example.test",role:"owner"};
      next();
    });
    registerHrdEmployeeStatusRoutes(router);
    const app=express();app.use(express.json());app.use("/api",router);
    server=createServer(app);server.listen(0,"127.0.0.1");await once(server,"listening");
    const addr=server.address();
    if(!addr||typeof addr==="string")throw Error("NO_SERVER");
    root="http://127.0.0.1:"+addr.port;
  });
  afterAll(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));});
  beforeEach(()=>{
    vi.stubEnv("APP_ENV","production");vi.stubEnv("HRD_PROD_ENABLED","true");vi.stubEnv("HRD_EMPLOYEE_STATUS_WRITE_ENABLED","true");
    state.companyId=1;state.employeeId=61;state.employeeStatus="active";state.auditFail=false;
    state.auditRows=0;state.commits=0;state.rollbacks=0;state.commands.length=0;
  });
  afterEach(()=>vi.unstubAllEnvs());
  const patch=(body:unknown,origin="https://bizportal.cstlogistic.co.id")=>fetch(
    root+"/api/hrd/employees/61/status?companyId=1",{
      method:"PATCH",headers:{"content-type":"application/json","origin":origin,"x-hrd-status-intent":"deactivate-employee"},
      body:JSON.stringify(body)
    });
  const valid={status:"inactive",confirm:true,reason:"Surat pengunduran diri diterima dan diverifikasi oleh HRD."};
  it("explicit false kill switch denies writes even while HRD is enabled",async()=>{
    vi.stubEnv("HRD_EMPLOYEE_STATUS_WRITE_ENABLED","false");
    expect((await patch(valid)).status).toBe(501);
    expect(state.commands).toHaveLength(0);
  });
  it("disabled HRD base service cannot mutate employee",async()=>{
    vi.stubEnv("HRD_PROD_ENABLED","false");
    expect((await patch(valid)).status).toBe(501);
    expect(state.commands).toHaveLength(0);
  });
  it("inherits enabled HRD workflow when extra status flag is unset",async()=>{
    vi.stubEnv("HRD_EMPLOYEE_STATUS_WRITE_ENABLED","");
    const r=await patch(valid);
    expect(r.status).toBe(200);
    expect(state.employeeStatus).toBe("inactive");
    expect(state.auditRows).toBe(1);
  });
  it("blocks missing/wrong origin and unconfirmed or short reason",async()=>{
    expect((await patch(valid,"https://invalid.example")).status).toBe(403);
    expect((await patch({...valid,confirm:false})).status).toBe(400);
    expect((await patch({...valid,reason:"resign"})).status).toBe(400);
    expect((await patch({...valid,status:"active"})).status).toBe(400);
    expect(state.commands).toHaveLength(0);
  });
  it("deactivates one active employee with an audit record and no deletions",async()=>{
    const r=await patch(valid);
    expect(r.status).toBe(200);
    const d=await r.json() as Record<string,unknown>;
    expect(d).toMatchObject({
      companyId:1,employeeId:61,status:"inactive",previousStatus:"active",
      auditRecorded:true,deleted:false,removedFromFuturePayroll:true,
      existingPayrollHistoryRetained:true,payrollPaid:false,payrollPosted:false,
    });
    expect(state.employeeStatus).toBe("inactive");
    expect(state.auditRows).toBe(1);
    expect(state.commands.some(q=>q.sql.includes("UPDATE public.employees SET status='inactive'"))).toBe(true);
    expect(state.commands.some(q=>q.sql.includes("INSERT INTO hrd_private.employee_status_audit"))).toBe(true);
    expect(state.commands.some(q=>/\bDELETE\b|\bpayroll_items\b|\bsalary_payments\b/i.test(q.sql))).toBe(false);
  });
  it("will not update other tenant or already-inactive employee",async()=>{
    state.companyId=3;
    expect((await patch(valid)).status).toBe(404);
    expect(state.auditRows).toBe(0);
    state.companyId=1;state.employeeStatus="inactive";
    expect((await patch(valid)).status).toBe(409);
    expect(state.auditRows).toBe(0);
  });
  it("rolls back status if audit recording fails",async()=>{
    state.auditFail=true;
    const r=await patch(valid);
    expect(r.status).toBe(503);
    expect(state.rollbacks).toBe(1);
    expect(state.employeeStatus).toBe("active");
    expect(state.auditRows).toBe(0);
  });
  it("returns tenant-scoped audit history without financial information",async()=>{
    state.auditRows=1;
    const r=await fetch(root+"/api/hrd/employees/61/status-history?companyId=1");
    expect(r.status).toBe(200);
    const d=await r.json() as Record<string,unknown>;
    expect(d).toMatchObject({companyId:1,employeeId:61});
    expect(JSON.stringify(d)).not.toMatch(/salary|bank|password/i);
  });
});
