/** Isolated UI contract — NO PROD API or database access. */
import {afterEach,describe,expect,it,vi} from "vitest";
import {cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {PayrollProdRunControls} from "@/pages/hr/PayrollProdRunControls";

const fake=<T,>(body:T,status=200)=>Promise.resolve(new Response(JSON.stringify(body),{
 status,headers:{"Content-Type":"application/json"},
}));
const digest="a".repeat(64);
const base={companyId:5,runId:11,status:"draft",canViewSetup:true,canApplySetup:true,
 canApproveSuperAdmin:false};
const payrollPreview={
 companyId:5,runId:11,effectiveThrough:"2026-12-31",
 employeeCount:1,configuredCount:1,missingSalaryCount:0,
 missingDeductionConfigCount:0,invalidCount:0,
 gross:"5500000.00",deductions:"1160000.00",net:"4340000.00",digest,
 rows:[{employeeId:45,employeeName:"DEMO PAYROLL",salaryEffectiveFrom:"2026-11-01",
  baseSalary:"5000000.00",allowance:"500000.00",gross:"5500000.00",
  totalDeductions:"1160000.00",net:"4340000.00",deductions:{kasbon_deduction:"900000.00"},
  issues:[],missingDeductionCodes:[]}],
};
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.restoreAllMocks();});
describe("Payroll PROD opt-in UI — preserves existing components",()=>{
 it("renders no controls when every flag is disabled and makes no request",()=>{
  const fetch=vi.fn();
  vi.stubGlobal("fetch",fetch);
  const {container}=render(<PayrollProdRunControls
    companyId={5} runId={11} status="draft"
    canViewSetup={false} canApplySetup={false} canApproveSuperAdmin={false}
    onChanged={vi.fn(async()=>{})}/>);
  expect(container.textContent).toBe("");
  expect(fetch).not.toHaveBeenCalled();
 });
 it("previews source-verified FULL/INSTALLMENT before applying only new Draft items",async()=>{
  const changed=vi.fn(async()=>{});
  const calls:Array<{url:string;init:RequestInit|undefined}>=[];
  const fetch=vi.fn(async(url:string,init?:RequestInit)=>{
   calls.push({url:String(url),init});
   if(url.includes("/setup-preview"))return fake(payrollPreview);
   if(url.includes("/apply-setup"))return fake({
    companyId:5,runId:11,added:1,skipped:0,readyForPayment:false,
   });
   return fake({message:"NOT_AUTHORIZED"},404);
  });
  vi.stubGlobal("fetch",fetch);
  vi.spyOn(window,"confirm").mockReturnValue(true);
  render(<PayrollProdRunControls {...base} onChanged={changed}/>);
  fireEvent.click(screen.getByRole("button",{name:"Pratinjau Struktur Gaji & Kasbon"}));
  const apply=await screen.findByRole("button",{name:"Terapkan ke Draft (Hanya Item Baru)"});
  expect(apply).toHaveProperty("disabled",false);
  expect(screen.getByText("DEMO PAYROLL")).toBeTruthy();
  fireEvent.click(apply);
  await waitFor(()=>expect(changed).toHaveBeenCalledTimes(1));
  const post=calls.find(x=>x.url.includes("/apply-setup"));
  expect(post?.init?.method).toBe("POST");
  expect(JSON.parse(String(post?.init?.body))).toEqual({confirm:true,expectedDigest:digest});
  expect(calls.some(x=>/payment|journal|settle/.test(x.url))).toBe(false);
 });
 it("requires exact preview, ten-character note and one Super Admin approval only",async()=>{
  const changed=vi.fn(async()=>{});
  const calls:Array<{url:string;init:RequestInit|undefined}>=[];
  const fetch=vi.fn(async(url:string,init?:RequestInit)=>{
   calls.push({url:String(url),init});
   if(url.includes("/super-admin-approval-preview"))return fake({
    companyId:5,runId:11,status:"draft",canApprove:true,blockedReasons:[],
    itemCount:1,gross:"5500000.00",deductions:"1160000.00",
    net:"4340000.00",digest,fullCoverage:true,kasbonReservationVerified:true,
   });
   if(url.includes("/super-admin-approve"))return fake({
    companyId:5,runId:11,status:"reviewed",oneSuperAdminApproval:true,
    readyForPayment:false,paid:false,accountingPosted:false,
   });
   return fake({message:"UNEXPECTED"},404);
  });
  vi.stubGlobal("fetch",fetch);
  vi.spyOn(window,"confirm").mockReturnValue(true);
  const {rerender}=render(<PayrollProdRunControls {...base}
    canApproveSuperAdmin={true} onChanged={changed}/>);
  fireEvent.click(screen.getByRole("button",{name:"Periksa Sebelum Disetujui"}));
  const save=await screen.findByRole("button",{name:"Setujui Satu Kali & Kunci Draft"});
  expect(save).toHaveProperty("disabled",true);
  fireEvent.change(screen.getByLabelText("Catatan Persetujuan Super Admin Payroll PROD"),{
   target:{value:"QA verified salary and automatic FULL+INSTALLMENT reservations."},
  });
  await waitFor(()=>expect(save).toHaveProperty("disabled",false));
  fireEvent.click(save);
  await waitFor(()=>expect(changed).toHaveBeenCalledTimes(1));
  const post=calls.find(x=>x.url.includes("/super-admin-approve")&&!x.url.includes("preview"));
  expect(JSON.parse(String(post?.init?.body))).toMatchObject({confirm:true,expectedDigest:digest});
  rerender(<PayrollProdRunControls {...base} status="reviewed" canApproveSuperAdmin={true}
    onChanged={changed}/>);
  expect(screen.queryByRole("button",{name:"Setujui Satu Kali & Kunci Draft"})).toBeNull();
  expect(calls.filter(x=>x.url.includes("/super-admin-approve")&&!x.url.includes("preview"))).toHaveLength(1);
 });
 it("prevents source mismatch when preview returns another company or run",async()=>{
  const changed=vi.fn(async()=>{});
  const fetch=vi.fn(async()=>fake({...payrollPreview,companyId:1}));
  vi.stubGlobal("fetch",fetch);
  render(<PayrollProdRunControls {...base} onChanged={changed}/>);
  fireEvent.click(screen.getByRole("button",{name:"Pratinjau Struktur Gaji & Kasbon"}));
  await waitFor(()=>expect(fetch).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole("button",{name:"Terapkan ke Draft (Hanya Item Baru)"})).toBeNull();
  expect(changed).not.toHaveBeenCalled();
 });
});
