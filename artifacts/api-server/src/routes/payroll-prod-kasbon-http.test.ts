import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from "vitest";
import express from "express";
import {createServer,type Server} from "node:http";
import {once} from "node:events";

const state=vi.hoisted(()=>({
 actor:{id:"super-qa-1",role:"super_admin",email:"qa@example.test",companyId:null} as any,
 canConnect:true,advanceStatus:"partial",balance:"1500000.00",paid:"500000.00",
 plan:null as null|{advanceId:string;choice:string;installmentAmount:string|null;firstPeriod:string;notes:string},
 sql:[] as string[],values:[] as unknown[][],commits:0,rollbacks:0,inserts:0,failInsert:false,
}));
vi.mock("./dev-auth",()=>({
 isDevelopmentEnvironment:()=>false,
 getProductionSession:()=> "test-prod-session",
 getProductionUser:async()=>state.actor,
 getDevSession:()=>null,
}));
vi.mock("@workspace/db",()=>({pool:{query:()=>{throw Error("SHARED_POOL_FORBIDDEN")}}}));
async function query(sql:string,args:unknown[]=[]):Promise<any>{
 state.sql.push(sql);state.values.push(args);
 if(sql==="COMMIT"){state.commits++;return {rowCount:0,rows:[]};}
 if(sql==="ROLLBACK"){state.rollbacks++;return {rowCount:0,rows:[]};}
 if(sql.includes("FROM public.employees"))return {rowCount:1,rows:[{id:51}]};
 if(sql.includes("FROM public.cash_advances a")){
  if(Number(args[0])!==5 || Number(args[1])!==51 || (args.length>=3 && Number(args[2])!==101))
   return {rowCount:0,rows:[]};
  return {rowCount:1,rows:[{
   id:"101",companyId:"5",employeeId:"51",type:"kasbon",
   status:state.advanceStatus,lifecycleStatus:"partially_settled",currency:"IDR",
   amount:"2000000.00",paidAmount:state.paid,settledAmount:"0.00",remainingAmount:state.balance,
   approvedAt:"2026-10-01",approvedBy:"qa-super-admin",disbursedAt:"2026-10-02",disbursedBy:"qa-finance",
   accountingEntryId:9001,postingStatus:"posted",voidedAt:null,
  }]};
 }
 if(sql.includes("FROM public.payroll_kasbon_auto_plans"))return {
  rowCount:state.plan?1:0,rows:state.plan?[state.plan]:[],
 };
 if(sql.includes("INSERT INTO public.payroll_kasbon_auto_plans")){
  state.inserts++;
  if(state.failInsert)throw Error("SIMULATED_SQL_FAILURE");
  state.plan={advanceId:String(args[2]),choice:String(args[3]),
   installmentAmount:args[4]===null?null:String(args[4]),
   firstPeriod:String(args[5]),notes:String(args[6])};
  return {rowCount:1,rows:[{id:"90"}]};
 }
 return {rowCount:0,rows:[]};
}
vi.mock("./payroll-prod-db",()=>({
 payrollReadOnlyReady:()=>state.canConnect,
 payrollDedicatedEnabled:()=>state.canConnect,
 payrollProdDedicatedRequired:()=>state.canConnect,
 payrollScopedQuery:async(companyId:number,sql:string,args:unknown[])=>{
  state.sql.push("SCOPED_COMPANY "+companyId);
  return query(sql,args);
 },
 setPayrollCompanyScope:async(_client:unknown,id:number)=>{state.sql.push("SET LOCAL ROLE bizportal_payroll_prod");state.sql.push("SCOPED_COMPANY "+id);},
 getPayrollPool:()=>({connect:async()=>({query,release:()=>{}})}),
}));
describe("PROD gated FULL/INSTALLMENT HTTP with mocked dedicated SQL",()=>{
 let server:Server,root:string;
 const payload={employeeId:51,choice:"INSTALLMENT",installmentAmount:"500000.00",
  firstPeriod:"2026-11-01",notes:"QA monthly deduction approval"};
 beforeAll(async()=>{
  const {default:router}=await import("./payroll");
  const app=express();app.use(express.json());
  app.use((req,_res,next)=>{(req as any).log={error:()=>{}};next();});
  app.use("/api",router);
  server=createServer(app);server.listen(0,"127.0.0.1");await once(server,"listening");
  const a=server.address();if(!a||typeof a==="string")throw Error("NO_TEST_PORT");
  root="http://127.0.0.1:"+a.port;
 });
 afterAll(async()=>{await new Promise<void>(r=>server.close(()=>r()))});
 beforeEach(()=>{
  state.actor={id:"super-qa-1",role:"super_admin",email:"qa@example.test",companyId:null};
  state.canConnect=true;state.advanceStatus="partial";state.balance="1500000.00";state.paid="500000.00";
  state.plan=null;state.sql=[];state.values=[];state.commits=0;state.rollbacks=0;state.inserts=0;state.failInsert=false;
  process.env.APP_ENV="production";process.env.PAYROLL_PROD_REQUIRE_DEDICATED_DB="true";
  delete process.env.PAYROLL_PROD_KASBON_AUTO_WRITE_ENABLED;
 });
 const preview=()=>fetch(root+"/api/payroll/kasbon/employee/51?companyId=5&year=2026&month=11");
 const save=(body:unknown,company=5)=>fetch(root+"/api/payroll/kasbon/plans/101?companyId="+company,{
  method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify(body),
 });
 it("fail-closed write flag, read preview without SQL mutations",async()=>{
  const read=await preview();expect(read.status).toBe(200);
  expect(await read.json()).toMatchObject({preview:{canApply:false,total:null,rows:[{issue:"PILIH_PENUH_ATAU_CICILAN"}]}});
  expect((await save(payload)).status).toBe(501);
  expect(state.inserts).toBe(0);
  expect(state.sql.join(" ")).not.toMatch(/UPDATE\s+public\.cash_advances/);
 });
 it("saves INSTALLMENT with scoped dedicated role, reads projection back, never settles",async()=>{
  process.env.PAYROLL_PROD_KASBON_AUTO_WRITE_ENABLED="true";
  const resp=await save(payload);expect(resp.status).toBe(200);
  expect(await resp.json()).toMatchObject({choice:"INSTALLMENT",estimatedCurrentDeduction:"500000.00",settledCashAdvance:false});
  const p=await preview();expect(p.status).toBe(200);
  expect(await p.json()).toMatchObject({preview:{total:"500000.00",canApply:true},
   advances:[{choice:"INSTALLMENT",installmentAmount:"500000.00"}]});
  expect(state.sql).toContain("SET LOCAL ROLE bizportal_payroll_prod");
  expect(state.inserts).toBe(1);expect(state.commits).toBe(1);
  expect(state.sql.join(" ")).not.toMatch(/(?:UPDATE|INSERT INTO|DELETE FROM)\s+public\.(cash_advances|payroll_items|accounting_entries|salary_payments)/);
 });
 it("FULL calculates only remaining amount and checks source state",async()=>{
  process.env.PAYROLL_PROD_KASBON_AUTO_WRITE_ENABLED="true";
  const resp=await save({...payload,choice:"FULL",installmentAmount:null});
  expect(resp.status).toBe(200);
  expect(await resp.json()).toMatchObject({choice:"FULL",estimatedCurrentDeduction:"1500000.00"});
  state.plan=null;state.advanceStatus="DRAFT";
  expect((await save(payload)).status).toBe(409);
  expect(state.inserts).toBe(1);
 });
 it("rejects wrong role, other company, malformed installments, zero and wrong date",async()=>{
  process.env.PAYROLL_PROD_KASBON_AUTO_WRITE_ENABLED="true";
  state.actor.role="admin";expect((await save(payload)).status).toBe(403);
  state.actor.role="super_admin";expect((await save(payload,6)).status).toBe(404);
  expect((await save({...payload,installmentAmount:"0.00"})).status).toBe(400);
  expect((await save({...payload,choice:"FULL",installmentAmount:"500000.00"})).status).toBe(400);
  expect((await save({...payload,firstPeriod:"2026-11-15"})).status).toBe(400);
  expect(state.inserts).toBe(0);
 });
 it("rolls back failed plan upsert; no false success or cash source mutation",async()=>{
  process.env.PAYROLL_PROD_KASBON_AUTO_WRITE_ENABLED="true";
  state.failInsert=true;
  expect((await save(payload)).status).toBe(503);
  expect(state.commits).toBe(0);expect(state.rollbacks).toBe(1);
 });
});
