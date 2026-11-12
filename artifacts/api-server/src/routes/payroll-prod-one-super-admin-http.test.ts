import express from "express";
import {createServer,type Server} from "node:http";
import {once} from "node:events";
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from "vitest";

const state=vi.hoisted(()=>({
 actor:{id:"super-admin-qa",email:"qa@example.test",role:"super_admin",companyId:null} as any,
 enabled:true,runStatus:"draft",approvedAt:null as string|null,notes:"QA Draft",
 staffCount:1,itemCount:1,
 item:{id:81,employee_id:45,base_salary:"5000000.00",allowance:"1000000.00",
  gross_salary:"6000000.00",bpjs_jht_employee:"100000.00",bpjs_kes_employee:"50000.00",
  pph21:"25000.00",other_deductions:"10000.00",kasbon_deduction:"0.00",
  total_deductions:"185000.00",net_salary:"5815000.00",is_paid:false},
 holds:[] as Array<Record<string,unknown>>,
 sql:[] as string[],values:[] as unknown[][],commits:0,rollbacks:0,failUpdate:false,
}));
async function query(sql:string,args:unknown[]=[]):Promise<any>{
 state.sql.push(sql);state.values.push(args);
 if(sql==="COMMIT"){state.commits++;return {rowCount:0,rows:[]};}
 if(sql==="ROLLBACK"){state.rollbacks++;return {rowCount:0,rows:[]};}
 if(sql.includes("FROM public.payroll_runs"))return {rowCount:1,rows:[{
  status:state.runStatus,posting_status:"pending",accounting_entry_id:null,payment_entry_id:null,
  approved_at:state.approvedAt,notes:state.notes,
 }]};
 if(sql.includes("count(*)::integer AS total FROM public.employees"))
  return {rowCount:1,rows:[{total:state.staffCount}]};
 if(sql.includes("count(*)::integer AS total FROM public.payroll_items"))
  return {rowCount:1,rows:[{total:state.itemCount}]};
 if(sql.includes("FROM public.payroll_items pi"))
  return {rowCount:1,rows:[state.item]};
 if(sql.includes("FROM public.payroll_kasbon_auto_reservations r"))
  return {rowCount:state.holds.length,rows:state.holds};
 if(sql.includes("UPDATE public.payroll_runs")){
  if(state.failUpdate)throw Error("SIMULATED_APPROVAL_FAILURE");
  state.runStatus="reviewed";
  state.approvedAt="2026-11-12T12:10:00Z";
  state.notes+="\n"+String(args[2]);
  return {rowCount:1,rows:[{id:8,status:state.runStatus,approved_at:state.approvedAt,notes:state.notes}]};
 }
 return {rowCount:1,rows:[]};
}
vi.mock("./dev-auth",()=>({
 isDevelopmentEnvironment:()=>false,
 getProductionSession:()=> "qa-prod-session",
 getProductionUser:async()=>state.actor,
 getDevSession:()=>null,
}));
vi.mock("@workspace/db",()=>({pool:{query:()=>{throw Error("SHARED_POOL_FORBIDDEN")}}}));
vi.mock("./payroll-prod-db",()=>({
 payrollDedicatedEnabled:()=>state.enabled,
 payrollProdDedicatedRequired:()=>state.enabled,
 payrollScopedQuery:async(companyId:number,sql:string,args:unknown[])=>{
  state.sql.push("SCOPED_COMPANY "+companyId);
  return query(sql,args);
 },
 getPayrollPool:()=>({connect:async()=>({query,release:()=>{}})}),
 setPayrollCompanyScope:async(_client:unknown,companyId:number)=>{
  state.sql.push("SET LOCAL ROLE bizportal_payroll_prod");
  state.sql.push("SCOPED_COMPANY "+companyId);
 },
}));

describe("canonical PROD one-Super-Admin approval: gated, locked, no journal/payment",()=>{
 let server:Server,root:string;
 const preview=()=>fetch(root+"/api/payroll/runs/8/super-admin-approval-preview?companyId=5");
 const approve=(body:unknown)=>fetch(root+"/api/payroll/runs/8/super-admin-approve?companyId=5",{
  method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body),
 });
 beforeAll(async()=>{
  const {default:router}=await import("./payroll");
  const app=express();app.use(express.json());
  app.use((req,_res,next)=>{(req as any).log={error:()=>{}};next();});
  app.use("/api",router);server=createServer(app);
  server.listen(0,"127.0.0.1");await once(server,"listening");
  const a=server.address();if(!a||typeof a==="string")throw Error("NO_PORT");
  root="http://127.0.0.1:"+a.port;
 });
 afterAll(async()=>{await new Promise<void>(r=>server.close(()=>r()))});
 beforeEach(()=>{
  state.actor={id:"super-admin-qa",email:"qa@example.test",role:"super_admin",companyId:null};
  state.enabled=true;state.runStatus="draft";state.approvedAt=null;state.notes="QA Draft";
  state.staffCount=1;state.itemCount=1;state.holds=[];
  state.item={id:81,employee_id:45,base_salary:"5000000.00",allowance:"1000000.00",
   gross_salary:"6000000.00",bpjs_jht_employee:"100000.00",bpjs_kes_employee:"50000.00",
   pph21:"25000.00",other_deductions:"10000.00",kasbon_deduction:"0.00",
   total_deductions:"185000.00",net_salary:"5815000.00",is_paid:false};
  state.sql=[];state.values=[];state.commits=0;state.rollbacks=0;state.failUpdate=false;
  process.env.APP_ENV="production";process.env.PAYROLL_PROD_REQUIRE_DEDICATED_DB="true";
  delete process.env.PAYROLL_PROD_SUPER_ADMIN_APPROVAL_ENABLED;
 });
 it("read-only preview disabled until explicit flag; no SQL write",async()=>{
  const p=await preview();expect(p.status).toBe(200);
  expect(await p.json()).toMatchObject({canApprove:false,blockedReasons:["SUPER_ADMIN_APPROVAL_DISABLED"],
   gross:"6000000.00",deductions:"185000.00",net:"5815000.00",readyForPayment:false});
  expect((await approve({confirm:true})).status).toBe(501);
  expect(state.commits).toBe(0);
  state.actor.role="owner";expect((await preview()).status).toBe(403);
  state.actor.role="admin";expect((await preview()).status).toBe(403);
 });
 it("approves exactly once under Super Admin; writes only run receipt, no HR/accounting/post/pay",async()=>{
  process.env.PAYROLL_PROD_SUPER_ADMIN_APPROVAL_ENABLED="true";
  const p=await preview();expect(p.status).toBe(200);
  const data=await p.json() as any;expect(data.canApprove).toBe(true);
  const resp=await approve({confirm:true,expectedDigest:data.digest,
   note:"QA tested complete salaries and deductions, no payment or journal."});
  expect(resp.status).toBe(200);
  expect(await resp.json()).toMatchObject({companyId:5,runId:8,status:"reviewed",oneSuperAdminApproval:true,
   hrReviewRequired:false,accountingReviewRequired:false,readyForPayment:false,accountingPosted:false,paid:false});
  expect(state.commits).toBe(1);
  expect(state.sql.filter(s=>s.includes("UPDATE public.payroll_runs"))).toHaveLength(1);
  expect(state.notes).toContain("[PAYROLL_SUPER_ADMIN_APPROVAL_V1]");
  expect(state.sql).toContain("SET LOCAL ROLE bizportal_payroll_prod");
  expect(state.sql.join(" ")).not.toMatch(/(?:INSERT INTO|UPDATE|DELETE FROM)\s+public\.(payroll_hr_reviews|payroll_accounting_reviews|cash_advances|accounting_entries|accounting_payments|salary_payments)/);
  expect((await approve({confirm:true,expectedDigest:data.digest,note:"QA retry is blocked"})).status).toBe(409);
  expect(state.commits).toBe(1);
 });
 it("rejects stale digest, incomplete coverage and unsupported manually edited kasbon",async()=>{
  process.env.PAYROLL_PROD_SUPER_ADMIN_APPROVAL_ENABLED="true";
  const p=await preview();const data=await p.json() as any;
  state.staffCount=2;
  expect((await approve({confirm:true,expectedDigest:data.digest,note:"QA incomplete staff"})).status).toBe(409);
  state.staffCount=1;
  expect((await approve({confirm:true,expectedDigest:"f".repeat(64),note:"QA digest has changed"})).status).toBe(409);
  state.item.kasbon_deduction="300000.00";
  state.item.total_deductions="485000.00";
  state.item.net_salary="5515000.00";
  const mismatch=await preview();
  expect(await mismatch.json()).toMatchObject({canApprove:false,kasbonReservationVerified:false});
  expect(state.commits).toBe(0);
 });
 it("failed transaction is rolled back and cannot be reported as approved",async()=>{
  process.env.PAYROLL_PROD_SUPER_ADMIN_APPROVAL_ENABLED="true";
  const p=await preview();const data=await p.json() as any;
  state.failUpdate=true;
  expect((await approve({confirm:true,expectedDigest:data.digest,note:"QA rollback on source update failure"})).status).toBe(503);
  expect(state.rollbacks).toBe(1);expect(state.commits).toBe(0);
  expect(state.runStatus).toBe("draft");
 });
});
