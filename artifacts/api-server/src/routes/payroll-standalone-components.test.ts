import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import { once } from "node:events";

const state=vi.hoisted(()=>({
  role:"super_admin",companyId:5,
  queries:[] as Array<{sql:string;args:unknown[]}>,
  committed:0,rolledBack:0,released:0,
  employeeExists:true,failInsertAt:0,insertCount:0,
  profile:null as null|{effectiveFrom:string;baseSalary:string;allowance:string;notes:string},
  deductionRows:[] as Array<{code:string;amount:string;notes:string}>,
}));
vi.mock("@workspace/db",()=>({
 pool:{
  connect:async()=>({
   query:async(sql:string,args:unknown[]=[])=>{
    state.queries.push({sql,args});
    if(sql==="COMMIT"){state.committed++;return {rowCount:0,rows:[]};}
    if(sql==="ROLLBACK"){state.rolledBack++;return {rowCount:0,rows:[]};}
    if(sql.includes("SELECT id FROM public.employees")&&sql.includes("status='active'")){
      const put=sql.includes("FOR UPDATE");
      const companyId=Number(args[put?0:1]);
      const employeeId=Number(args[put?1:0]);
      const match=state.employeeExists&&companyId===5&&employeeId===61;
      return {rowCount:match?1:0,rows:match?[{id:61}]:[]};
    }
    if(sql.includes("FROM public.employees")&&sql.includes("ORDER BY first_name")){
      return {rowCount:1,rows:[{id:61,firstName:"QA",lastName:"TEST"}]};
    }
    if(sql.includes("FROM public.payroll_salary_profiles")&&sql.includes("ORDER BY")){
      return {rowCount:state.profile?1:0,rows:state.profile?[state.profile]:[]};
    }
    if(sql.includes("FROM public.payroll_deduction_settings")&&sql.includes("WHERE company_id")){
      return {rowCount:state.deductionRows.length,rows:state.deductionRows};
    }
    if(sql.includes("INSERT INTO public.payroll_salary_profiles")){
      state.insertCount++;
      if(state.failInsertAt===state.insertCount)throw Error("SIMULATED_INSERT_FAILURE");
      state.profile={effectiveFrom:String(args[2]),baseSalary:String(args[3]),allowance:String(args[4]),notes:String(args[5])};
      return {rowCount:1,rows:[]};
    }
    if(sql.includes("INSERT INTO public.payroll_deduction_settings")){
      state.insertCount++;
      if(state.failInsertAt===state.insertCount)throw Error("SIMULATED_INSERT_FAILURE");
      const row={code:String(args[3]),amount:String(args[4]),notes:String(args[5])};
      state.deductionRows=state.deductionRows.filter(x=>x.code!==row.code).concat(row);
      return {rowCount:1,rows:[]};
    }
    return {rowCount:0,rows:[]};
   },
   release:()=>{state.released++},
  }),
  query:async()=>{throw Error("NO_UNSCOPED_QUERY")},
 },
}));

describe("PROD standalone Payroll components — isolation and exact cash advance deductions",()=>{
 let server:Server,root:string;
 beforeAll(async()=>{
  const {registerStandalonePayrollComponents}=await import("./payroll-standalone-components");
  const app=express();app.use(express.json());
  app.use((req,_res,next)=>{
   (req as any).payrollCompanyId=state.companyId;
   (req as any).payrollActor={role:state.role};
   (req as any).log={error:()=>{}};
   next();
  });
  const router=express.Router();registerStandalonePayrollComponents(router);
  app.use("/api",router);
  server=createServer(app);server.listen(0,"127.0.0.1");await once(server,"listening");
  const a=server.address();if(!a||typeof a==="string")throw Error("NO_TEST_PORT");
  root="http://127.0.0.1:"+a.port;
 });
 afterAll(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()))});
 beforeEach(()=>{
  state.role="super_admin";state.companyId=5;state.queries=[];state.committed=0;
  state.rolledBack=0;state.released=0;state.employeeExists=true;
  state.failInsertAt=0;state.insertCount=0;state.profile=null;state.deductionRows=[];
  delete process.env.PAYROLL_PROD_COMPONENTS_ENABLED;
 });
 afterEach(()=>{delete process.env.PAYROLL_PROD_COMPONENTS_ENABLED;vi.unstubAllEnvs()});
 const url=(suffix="61")=>root+"/api/payroll/components/"+suffix;
 const save=(body:unknown,path=url())=>fetch(path,{
  method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(body),
 });
 const example={
  effectiveFrom:"2026-11-01",notes:"HR kasbon manual NO-QA-01",
  baseSalary:"5000000.00",allowance:"1000000.00",
  bpjsJhtEmployee:"100000.00",bpjsKesEmployee:"50000.00",
  pph21:"50000.00",otherDeductions:"25000.00",kasbonDeduction:"200000.25",
 };
 it("defaults completely unavailable with no SQL",async()=>{
  expect((await save(example)).status).toBe(501);
  expect((await fetch(url())).status).toBe(404);
  expect((await fetch(root+"/api/payroll/components/employees")).status).toBe(404);
  expect(state.queries).toHaveLength(0);
 });
 it("requires explicit opt-in even in production; false or missing flag fails closed",async()=>{
  vi.stubEnv("NODE_ENV","production");vi.stubEnv("APP_ENV","development");
  expect((await fetch(url())).status).toBe(404);
  vi.stubEnv("APP_ENV","production");
  expect((await fetch(url())).status).toBe(404);
  vi.stubEnv("APP_ENV","");
  expect((await fetch(url())).status).toBe(404);
  process.env.PAYROLL_PROD_COMPONENTS_ENABLED="true";
  expect((await fetch(url())).status).toBe(200);
  process.env.PAYROLL_PROD_COMPONENTS_ENABLED="false";
  expect((await fetch(url())).status).toBe(404);
  expect((await save(example)).status).toBe(501);
  expect(state.queries.every(q=>!q.sql.includes("INSERT"))).toBe(true);
 });
 it("requires Owner or Super Admin, rejects other roles before SQL",async()=>{
  process.env.PAYROLL_PROD_COMPONENTS_ENABLED="true";
  for(const role of ["finance","admin","member",""]){
   state.role=role;
   expect((await save(example)).status).toBe(403);
   expect((await fetch(url())).status).toBe(403);
  }
  expect(state.queries).toHaveLength(0);
 });
 it("rejects missing component, negative value, kasbon source and deductions exceeding gross",async()=>{
  process.env.PAYROLL_PROD_COMPONENTS_ENABLED="true";
  const bad=[
   {...example,kasbonDeduction:undefined},
   {...example,kasbonDeduction:"-1.00"},
   {...example,kasbonDeduction:"0.001"},
   {...example,otherDeductions:undefined},
   {...example,notes:""},
   {...example,notes:"test"},
   {...example,baseSalary:"0.00"},
   {...example,effectiveFrom:"2026-02-30"},
  ];
  for(const x of bad)expect((await save(x)).status).toBe(400);
  expect((await save({...example,kasbonDeduction:"9999999.00"})).status).toBe(409);
  expect(state.queries).toHaveLength(0);
 });
 it("saves seven components in one transaction; reads back exact gross, deductions, and net",async()=>{
  process.env.PAYROLL_PROD_COMPONENTS_ENABLED="true";
  const resp=await save(example);expect(resp.status).toBe(200);
  expect(await resp.json()).toMatchObject({
   companyId:5,employeeId:61,componentsSaved:7,
   gross:"6000000.00",deductions:"425000.25",net:"5574999.75",
   appliedToPayroll:false,posted:false,paid:false,settledKasbon:false,
  });
  const get=await fetch(url());expect(get.status).toBe(200);
  const data=await get.json();expect(data).toMatchObject({
   companyId:5,employeeId:61,complete:true,
   values:{baseSalary:"5000000.00",allowance:"1000000.00",kasbonDeduction:"200000.25"},
   summary:{gross:"6000000.00",deductions:"425000.25",net:"5574999.75"},
   canPay:false,canPost:false,
  });
  expect(state.committed).toBe(1);
  expect(state.queries.filter(x=>x.sql.includes("INSERT INTO public.payroll_"))).toHaveLength(6);
  expect(state.queries.filter(x=>x.sql.includes("set_config('app.payroll_company_id'")).length).toBe(2);
  expect(state.queries.every(q=>!/UPDATE\s+(?:public\.)?(?:cash_advances|payroll_items|accounting_entries|payment_entries)/i.test(q.sql))).toBe(true);
  expect(state.released).toBe(2);
 });
 it("rejects cross-tenant or nonexistent employee with rollback, no settings rows",async()=>{
  process.env.PAYROLL_PROD_COMPONENTS_ENABLED="true";
  state.companyId=6;
  expect((await save(example)).status).toBe(404);
  expect(state.committed).toBe(0);expect(state.rolledBack).toBe(1);
  expect(state.insertCount).toBe(0);
 });
 it("fails closed on database insert failure with rollback and no COMMIT",async()=>{
  process.env.PAYROLL_PROD_COMPONENTS_ENABLED="true";
  state.failInsertAt=3;
  expect((await save(example)).status).toBe(503);
  expect(state.committed).toBe(0);expect(state.rolledBack).toBe(1);
  expect(state.released).toBe(1);
 });
 it("read-only employee list is scoped and excludes deleted/inactive via SQL",async()=>{
  process.env.PAYROLL_PROD_COMPONENTS_ENABLED="true";
  const resp=await fetch(root+"/api/payroll/components/employees");
  expect(resp.status).toBe(200);
  expect(await resp.json()).toMatchObject({companyId:5,canEdit:true,employees:[{id:61,firstName:"QA"}]});
  const sql=state.queries.find(x=>x.sql.includes("ORDER BY first_name"))?.sql;
  expect(sql).toContain("company_id=$1");
  expect(sql).toContain("status='active'");
  expect(sql).toContain("deleted_at IS NULL");
  expect(state.queries.some(x=>x.sql.includes("set_config('app.payroll_company_id'"))).toBe(true);
 });
});
