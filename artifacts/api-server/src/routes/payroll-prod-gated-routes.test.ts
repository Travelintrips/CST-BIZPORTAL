import {afterAll,afterEach,beforeAll,describe,expect,it,vi} from "vitest";
import express,{Router} from "express";
import {createServer,type Server} from "node:http";
import {once} from "node:events";
import {registerPayrollKasbonAutoRoutes} from "./payroll-kasbon-automatic-routes";
import {registerPayrollSuperAdminApprovalRoutes} from "./payroll-super-admin-approval";
import {payrollProdDedicatedRequired} from "./payroll-prod-db";
describe("canonical PROD Payroll gated endpoints — never use shared DB",()=>{
 let server:Server,root:string;
 beforeAll(async()=>{
  const app=express();app.use(express.json());
  const router=Router();
  router.use((_req,res,next)=>{
   const req=_req as typeof _req & {payrollCompanyId:number;payrollActor:{role:string}};
   req.payrollCompanyId=5;req.payrollActor={role:"super_admin"};next();
  });
  registerPayrollKasbonAutoRoutes(router);
  registerPayrollSuperAdminApprovalRoutes(router);
  app.use("/api",router);
  server=createServer(app);server.listen(0,"127.0.0.1");await once(server,"listening");
  const addr=server.address();if(!addr||typeof addr==="string")throw Error("NO_PORT");
  root="http://127.0.0.1:"+addr.port;
 });
 afterAll(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()))});
 afterEach(()=>{
  vi.unstubAllEnvs();
 });
 it("missing every PROD flag fails closed without entering SQL or changing records",async()=>{
  vi.stubEnv("APP_ENV","production");vi.stubEnv("NODE_ENV","production");
  vi.stubEnv("PAYROLL_DATABASE_URL_PROD","");
  vi.stubEnv("PAYROLL_PROD_REQUIRE_DEDICATED_DB","");
  vi.stubEnv("PAYROLL_PROD_KASBON_AUTO_WRITE_ENABLED","");
  vi.stubEnv("PAYROLL_PROD_SUPER_ADMIN_APPROVAL_ENABLED","");
  expect(payrollProdDedicatedRequired()).toBe(false);
  const get=await fetch(root+"/api/payroll/kasbon/employee/45?year=2026&month=12");
  expect(get.status).toBe(503);
  const put=await fetch(root+"/api/payroll/kasbon/plans/11",{
   method:"PUT",headers:{"Content-Type":"application/json"},
   body:JSON.stringify({employeeId:45,choice:"FULL",installmentAmount:null,firstPeriod:"2026-12-01",notes:"QA only"}),
  });
  expect(put.status).toBe(501);
  const preview=await fetch(root+"/api/payroll/runs/11/super-admin-approval-preview");
  expect(preview.status).toBe(503);
  const approve=await fetch(root+"/api/payroll/runs/11/super-admin-approve",{
   method:"POST",headers:{"Content-Type":"application/json"},
   body:JSON.stringify({confirm:true,expectedDigest:"a".repeat(64),note:"QA only approval"}),
  });
  expect(approve.status).toBe(501);
 });
 it("a flag alone cannot activate the feature without the dedicated DB",async()=>{
  vi.stubEnv("APP_ENV","production");vi.stubEnv("NODE_ENV","production");
  vi.stubEnv("PAYROLL_DATABASE_URL_PROD","");
  vi.stubEnv("PAYROLL_PROD_REQUIRE_DEDICATED_DB","true");
  vi.stubEnv("PAYROLL_PROD_KASBON_AUTO_WRITE_ENABLED","true");
  vi.stubEnv("PAYROLL_PROD_SUPER_ADMIN_APPROVAL_ENABLED","true");
  expect(payrollProdDedicatedRequired()).toBe(false);
  expect((await fetch(root+"/api/payroll/kasbon/employee/45?year=2026&month=12")).status).toBe(503);
  expect((await fetch(root+"/api/payroll/runs/11/super-admin-approval-preview")).status).toBe(503);
  expect((await fetch(root+"/api/payroll/runs/11/super-admin-approve",{
   method:"POST",headers:{"Content-Type":"application/json"},
   body:JSON.stringify({confirm:true,expectedDigest:"a".repeat(64),note:"QA safe approval"}),
  })).status).toBe(501);
 });
 it("refuses generic/shared, DEV and cross-project database credentials",()=>{
  vi.stubEnv("APP_ENV","production");
  vi.stubEnv("PAYROLL_PROD_REQUIRE_DEDICATED_DB","true");
  const variants=[
   "postgresql://postgres:ci@db.nzdweipzckfszczzqtuw.supabase.co/postgres",
   "postgresql://bizportal_payroll_prod_login.xssrfshdrtdfupgqwfdw:ci@aws-1-ap-southeast-2.pooler.supabase.com/postgres",
   "postgresql://bizportal_payroll_dev.xssrfshdrtdfupgqwfdw:ci@db.xssrfshdrtdfupgqwfdw.supabase.co/postgres",
  ];
  for(const value of variants) {
   vi.stubEnv("PAYROLL_DATABASE_URL_PROD",value);
   expect(()=>payrollProdDedicatedRequired()).toThrow(/PAYROLL_PROD_DATABASE_PROJECT_OR_ROLE_MISMATCH/);
  }
 });
 it("valid-looking separate PROD identity still requires runtime opt-in and no query is executed",()=>{
  vi.stubEnv("APP_ENV","development");
  vi.stubEnv("PAYROLL_PROD_REQUIRE_DEDICATED_DB","true");
  vi.stubEnv("PAYROLL_DATABASE_URL_PROD","postgresql://bizportal_payroll_prod_login.nzdweipzckfszczzqtuw:ci@aws-1-ap-southeast-2.pooler.supabase.com/postgres");
  expect(payrollProdDedicatedRequired()).toBe(false);
  vi.stubEnv("APP_ENV","production");
  expect(payrollProdDedicatedRequired()).toBe(true);
  // No DB connect: only check the isolated scope/credential gate.
 });
});
