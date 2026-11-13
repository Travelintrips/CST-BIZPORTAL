import express from "express";
import {createServer,type Server} from "node:http";
import {once} from "node:events";
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from "vitest";

const state=vi.hoisted(()=>({
 actor:{id:"qa-superadmin",email:"qa@example.test",role:"super_admin",companyId:null} as any,
 companyId:5,available:true,runStatus:"draft",runExists:false,
 itemInserted:false,items:0,reservations:[] as any[],
 inserts:0,commits:0,rollbacks:0,sourceWrites:0,
 sql:[] as string[],params:[] as unknown[][],
 manualKasbon:"0.00",failReservation:false,
}));
const employee={employeeId:"45",firstName:"DEMO",lastName:"PAYROLL",
 baseSalary:"5000000.00",allowance:"500000.00",salaryEffectiveFrom:"2026-11-01"};
function deductions(){
 return [
  {employeeId:"45",code:"bpjs_jht_employee",amount:"100000.00",effectiveFrom:"2026-11-01"},
  {employeeId:"45",code:"bpjs_kes_employee",amount:"50000.00",effectiveFrom:"2026-11-01"},
  {employeeId:"45",code:"pph21",amount:"100000.00",effectiveFrom:"2026-11-01"},
  {employeeId:"45",code:"other_deductions",amount:"10000.00",effectiveFrom:"2026-11-01"},
  {employeeId:"45",code:"kasbon_deduction",amount:state.manualKasbon,effectiveFrom:"2026-11-01"},
 ];
}
const advances=[
 {id:"11",companyId:"5",employeeId:"45",type:"kasbon",status:"active",lifecycleStatus:"outstanding",
  currency:"IDR",amount:"600000.00",paidAmount:"0.00",settledAmount:"0.00",remainingAmount:"600000.00",
  approvedAt:"2026-11-01",approvedBy:"qa-superadmin",disbursedAt:"2026-11-02",disbursedBy:"qa-synthetic",
  accountingEntryId:648,postingStatus:"posted",voidedAt:null},
 {id:"12",companyId:"5",employeeId:"45",type:"kasbon",status:"active",lifecycleStatus:"outstanding",
  currency:"IDR",amount:"900000.00",paidAmount:"0.00",settledAmount:"0.00",remainingAmount:"900000.00",
  approvedAt:"2026-11-01",approvedBy:"qa-superadmin",disbursedAt:"2026-11-02",disbursedBy:"qa-synthetic",
  accountingEntryId:649,postingStatus:"posted",voidedAt:null},
];
const plans=[
 {companyId:"5",employeeId:"45",advanceId:"11",choice:"FULL",installmentAmount:null,firstPeriod:"2026-12-01",updatedAt:"2026-11-12"},
 {companyId:"5",employeeId:"45",advanceId:"12",choice:"INSTALLMENT",installmentAmount:"300000.00",firstPeriod:"2026-12-01",updatedAt:"2026-11-12"},
];

function read(sql:string,values:unknown[]=[]):any {
 if(sql.includes("SELECT id FROM public.payroll_runs WHERE company_id")){
  return {rowCount:state.runExists?1:0,rows:state.runExists?[{id:12}]:[]};
 }
 if(sql.includes("FROM public.payroll_runs"))
  return Number(values[0])===5 && Number(values[1])===11
   ?{rowCount:1,rows:[{month:12,year:2026,status:state.runStatus,id:11}]}:{rowCount:0,rows:[]};
 if(sql.includes("FROM public.employees e")&&sql.includes("LEFT JOIN LATERAL"))
  return {rowCount:1,rows:[employee]};
 if(sql.includes("FROM public.payroll_deduction_settings d"))
  return {rowCount:5,rows:deductions()};
 if(sql.includes("FROM public.cash_advances a"))
  return {rowCount:2,rows:advances};
 if(sql.includes("FROM public.payroll_kasbon_auto_plans"))
  return {rowCount:2,rows:plans};
 if(sql.includes("SELECT r.advance_id AS"))return {rowCount:state.reservations.length,rows:
  state.reservations.map(r=>({advanceId:r.advanceId,amount:r.amount,balance:r.balanceAtPreparation}))};
 if(sql.includes("FROM public.payroll_kasbon_auto_reservations"))
  return {rowCount:state.reservations.length,rows:state.reservations};
 return {rowCount:0,rows:[]};
}
async function query(sql:string,values:unknown[]=[]):Promise<any>{
 state.sql.push(sql);state.params.push(values);
 if(sql==="COMMIT"){state.commits++;return {rowCount:0,rows:[]};}
 if(sql==="ROLLBACK"){state.rollbacks++;return {rowCount:0,rows:[]};}
 if(sql.startsWith("INSERT INTO public.payroll_runs")){
  state.runExists=true;state.inserts++;
  return {rowCount:1,rows:[{id:12,company_id:5,year:2027,month:1,status:"draft",posting_status:"pending"}]};
 }
 if(sql.includes("INSERT INTO public.payroll_items")){
  if(state.itemInserted)return {rowCount:0,rows:[]};
  state.itemInserted=true;state.items++;state.inserts++;
  return {rowCount:1,rows:[{id:91}]};
 }
 if(sql.includes("INSERT INTO public.payroll_kasbon_auto_reservations")){
  if(state.failReservation)throw Error("QA_SIMULATED_RESERVATION_FAILURE");
  state.reservations.push({
   companyId:5,employeeId:45,runId:11,advanceId:Number(values[4]),period:String(values[5]),
   amount:String(values[6]),balanceAtPreparation:String(values[7]),state:"prepared",
  });state.inserts++;
  return {rowCount:1,rows:[{id:state.inserts}]};
 }
 if(/\b(?:INSERT|UPDATE|DELETE)\s+public\.(cash_advances|accounting_entries|salary_payments)/i.test(sql))
  state.sourceWrites++;
 if(sql.includes("SELECT r.advance_id AS"))return read(sql,values);
 return read(sql,values);
}
vi.mock("./dev-auth",()=>({
 isDevelopmentEnvironment:()=>false,getProductionSession:()=> "qa-session",
 getProductionUser:async()=>state.actor,getDevSession:()=>null,
}));
vi.mock("@workspace/db",()=>({pool:{query:()=>{throw Error("SHARED_POOL_FORBIDDEN")}}}));
vi.mock("./payroll-prod-db",()=>({
 payrollReadOnlyReady:()=>state.available,
 payrollDedicatedEnabled:()=>state.available,
 payrollProdDedicatedRequired:()=>state.available,
 payrollScopedQuery:async(_company:number,sql:string,values:unknown[])=>{
  state.sql.push("SCOPED_READ");return read(sql,values);
 },
 getPayrollPool:()=>({connect:async()=>({query,release:()=>{}})}),
 setPayrollCompanyScope:async(_client:unknown,company:number)=>{
  state.sql.push("SET LOCAL ROLE bizportal_payroll_prod");state.sql.push("SCOPE_COMPANY "+company);
 },
}));

describe("PROD gated Draft source-backed Penuh/Cicilan: preview / apply / replay",()=>{
 let server:Server,root:string;
 beforeAll(async()=>{
  const {default:router}=await import("./payroll");
  const app=express();app.use(express.json());app.use((req,_res,next)=>{
   (req as any).log={error:()=>{}};next();
  });
  app.use("/api",router);server=createServer(app);
  server.listen(0,"127.0.0.1");await once(server,"listening");
  const addr=server.address();if(!addr||typeof addr==="string")throw Error("NO_QA_PORT");
  root="http://127.0.0.1:"+addr.port;
 });
 afterAll(async()=>{await new Promise<void>(r=>server.close(()=>r()))});
 beforeEach(()=>{
  state.actor={id:"qa-superadmin",email:"qa@example.test",role:"super_admin",companyId:null};
  state.companyId=5;state.available=true;state.runStatus="draft";state.runExists=false;
  state.itemInserted=false;state.items=0;state.reservations=[];state.inserts=0;
  state.commits=0;state.rollbacks=0;state.sourceWrites=0;state.sql=[];state.params=[];
  state.manualKasbon="0.00";state.failReservation=false;
  process.env.APP_ENV="production";process.env.PAYROLL_PROD_REQUIRE_DEDICATED_DB="true";
  delete process.env.PAYROLL_PROD_DRAFT_ENABLED;
  delete process.env.PAYROLL_PROD_SETUP_APPLY_ENABLED;
 });
 const preview=()=>fetch(root+"/api/payroll/runs/11/setup-preview?companyId=5");
 const apply=(body:unknown,cid=5)=>fetch(root+"/api/payroll/runs/11/apply-setup?companyId="+cid,{
  method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body),
 });
 const draft=(body:unknown)=>fetch(root+"/api/payroll/runs?companyId=5",{
  method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body),
 });
 it("setup preview uses scoped role, calculates FULL and INSTALLMENT, and never writes",async()=>{
  const r=await preview();expect(r.status).toBe(200);
  const data=await r.json() as any;
  expect(data).toMatchObject({companyId:5,runId:11,employeeCount:1,invalidCount:0,
   gross:"5500000.00",deductions:"1160000.00",net:"4340000.00",
   rows:[{employeeId:45,net:"4340000.00",deductions:{kasbon_deduction:"900000.00"}}]});
  expect(state.inserts).toBe(0);expect(state.sourceWrites).toBe(0);
 });
 it("never applies Draft without explicit PROD flag",async()=>{
  const p=await preview();const data=await p.json() as any;
  expect((await apply({confirm:true,expectedDigest:data.digest})).status).toBe(501);
  expect(state.inserts).toBe(0);
 });
 it("creates only a scoped Draft when flag is set, rejects duplicate and validates input",async()=>{
  expect((await draft({month:1,year:2027})).status).toBe(501);
  process.env.PAYROLL_PROD_DRAFT_ENABLED="true";
  expect((await draft({month:13,year:2027})).status).toBe(400);
  const r=await draft({month:1,year:2027,notes:"QA TEST only"});
  expect(r.status).toBe(201);
  expect(await r.json()).toMatchObject({run:{id:12,companyId:5,status:"draft",postingStatus:"pending"},
    approved:false,posted:false,paid:false,generatedItems:false});
  expect((await draft({month:1,year:2027})).status).toBe(409);
  expect(state.commits).toBe(1);expect(state.inserts).toBe(1);expect(state.sourceWrites).toBe(0);
  expect(state.sql).toContain("SET LOCAL ROLE bizportal_payroll_prod");
 });
 it("applies exactly one payroll item and two reservations; retry is idempotent",async()=>{
  process.env.PAYROLL_PROD_SETUP_APPLY_ENABLED="true";
  const p=await preview();const data=await p.json() as any;
  const a=await apply({confirm:true,expectedDigest:data.digest});
  expect(a.status).toBe(200);
  expect(await a.json()).toMatchObject({companyId:5,runId:11,added:1,skipped:0,readyForPayment:false});
  expect(state.items).toBe(1);expect(state.reservations).toHaveLength(2);
  expect(state.reservations.map(r=>[r.advanceId,r.amount])).toEqual([[11,"600000.00"],[12,"300000.00"]]);
  const next=await preview();expect(next.status).toBe(200);
  const data2=await next.json() as any;
  const again=await apply({confirm:true,expectedDigest:data2.digest});
  expect(again.status).toBe(200);
  expect(await again.json()).toMatchObject({added:0,skipped:1});
  expect(state.items).toBe(1);expect(state.reservations).toHaveLength(2);
  expect(state.sourceWrites).toBe(0);
  expect(state.sql).toContain("SET LOCAL ROLE bizportal_payroll_prod");
 });
 it("fails closed on missing loan source, manual-double-input and cross-tenant request",async()=>{
  state.manualKasbon="300000.00";
  const p=await preview();expect(p.status).toBe(200);
  const data=await p.json() as any;
  expect(data.invalidCount).toBeGreaterThan(0);
  process.env.PAYROLL_PROD_SETUP_APPLY_ENABLED="true";
  expect((await apply({confirm:true,expectedDigest:data.digest})).status).toBe(409);
  expect((await apply({confirm:true,expectedDigest:data.digest},6)).status).toBe(404);
  expect(state.inserts).toBe(0);
 });
 it("rejects partial source write and rolls back all new items/reservations",async()=>{
  process.env.PAYROLL_PROD_SETUP_APPLY_ENABLED="true";
  const p=await preview();const data=await p.json() as any;
  state.failReservation=true;
  expect((await apply({confirm:true,expectedDigest:data.digest})).status).toBe(503);
  expect(state.rollbacks).toBe(1);expect(state.commits).toBe(0);
  expect(state.sourceWrites).toBe(0);
 });
 it("non-Super Admin cannot preview or create Draft even with flags",async()=>{
  state.actor={id:"accountant",email:"qa@example.test",role:"accounting",companyId:5};
  process.env.PAYROLL_PROD_SETUP_APPLY_ENABLED="true";
  process.env.PAYROLL_PROD_DRAFT_ENABLED="true";
  expect((await preview()).status).toBe(403);
  expect((await draft({month:1,year:2027})).status).toBe(403);
  expect(state.inserts).toBe(0);
 });
});
