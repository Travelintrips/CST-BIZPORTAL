import React from "react";
import { beforeEach,afterEach,describe,expect,it,vi } from "vitest";
import { cleanup,fireEvent,render,screen,waitFor } from "@testing-library/react";

const ctx=vi.hoisted(()=>({companyId:1 as number|null, consolidated:false}));
vi.mock("@/contexts/CompanyContext",()=>({useCompany:()=>({
 activeCompanyId:ctx.companyId,
 activeCompany:ctx.companyId?{companyName:"CST"}:null,
 isConsolidated:ctx.consolidated,
 isLoading:false,
})}));
vi.mock("@/components/layout/AppShell",()=>({AppShell:({children}:{children:React.ReactNode})=><div>{children}</div>}));
import PayrollStandaloneComponents from "@/pages/hr/payroll-components";

const reference={
 baseSalary:"5000000.00",allowance:"1000000.00",kasbonDeduction:"200000.25",
 bpjsJhtEmployee:"100000.00",bpjsKesEmployee:"50000.00",
 pph21:"50000.00",otherDeductions:"25000.00",
};
let payloads:Array<{method:string;path:string;body:any}>=[];
let stored=false;
function response(data:object,status=200){return{ok:status>=200&&status<300,status,json:async()=>data} as Response}
beforeEach(()=>{
 ctx.companyId=1;ctx.consolidated=false;stored=false;payloads=[];
 vi.stubGlobal("confirm",vi.fn(()=>true));
 vi.stubGlobal("fetch",vi.fn(async (url:string,init?:RequestInit)=>{
  const u=new URL(String(url),"http://localhost");const method=init?.method??"GET";
  payloads.push({method,path:u.pathname,body:init?.body?JSON.parse(String(init.body)):null});
  if(u.pathname==="/api/payroll/components/employees")return response({companyId:1,canEdit:true,employees:[{id:61,firstName:"QA",lastName:"TEST"}]});
  if(u.pathname==="/api/payroll/components/61"&&method==="GET")return response({
   companyId:1,employeeId:61,effectiveFrom:stored?"2026-11-01":null,
   notes:stored?"Catatan kasbon HR": "",
   values:stored?reference:Object.fromEntries(Object.keys(reference).map(k=>[k,null])),
   complete:stored,summary:stored?{gross:"6000000.00",deductions:"425000.25",net:"5574999.75"}:null,
  });
  if(u.pathname==="/api/payroll/components/61"&&method==="PUT"){
    stored=true;return response({companyId:1,employeeId:61,componentsSaved:7,gross:"6000000.00",
      deductions:"425000.25",net:"5574999.75",paid:false,posted:false,appliedToPayroll:false});
  }
  throw Error("UNEXPECTED_FETCH_"+u.pathname);
 }));
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});

describe("Standalone Payroll PROD compensation UI",()=>{
 it("never calls Payroll when there is no selected company",async()=>{
  ctx.companyId=null;ctx.consolidated=true;
  render(<PayrollStandaloneComponents/>);
  expect(screen.getByText(/Pilih satu perusahaan/)).toBeTruthy();
  expect(payloads).toHaveLength(0);
 });
 it("requires seven verified values and a kasbon source before enabling Save",async()=>{
  render(<PayrollStandaloneComponents/>);
  const choose=await screen.findByLabelText("Karyawan Payroll");
  await screen.findByRole("option",{name:/QA TEST/});
  fireEvent.change(choose,{target:{value:"61"}});
  await screen.findByLabelText("Gaji Pokok");
  const save=screen.getByRole("button",{name:"Simpan Gaji & Seluruh Potongan"}) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  for(const [name,value] of [
    ["Gaji Pokok",reference.baseSalary],["Tunjangan (termasuk uang makan)",reference.allowance],
    ["Potongan Kasbon",reference.kasbonDeduction],["BPJS JHT",reference.bpjsJhtEmployee],
    ["BPJS Kesehatan",reference.bpjsKesEmployee],["PPh21",reference.pph21],
    ["Potongan Lainnya",reference.otherDeductions],
  ])fireEvent.change(screen.getByLabelText(name),{target:{value}});
  expect(save.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Sumber komponen gaji"),{target:{value:"Catatan kasbon HR"}});
  await waitFor(()=>expect(save.disabled).toBe(false));
  expect(screen.getByText(/Rp\s*5.574.999,75/)).toBeTruthy();
  expect(payloads.filter(x=>x.method==="PUT")).toHaveLength(0);
 });
 it("writes only seven standalone components then checks persisted net on readback",async()=>{
  render(<PayrollStandaloneComponents/>);
  const choose=await screen.findByLabelText("Karyawan Payroll");
  await screen.findByRole("option",{name:/QA TEST/});
  fireEvent.change(choose,{target:{value:"61"}});
  await screen.findByLabelText("Gaji Pokok");
  for(const [name,value] of [
    ["Gaji Pokok",reference.baseSalary],["Tunjangan (termasuk uang makan)",reference.allowance],
    ["Potongan Kasbon",reference.kasbonDeduction],["BPJS JHT",reference.bpjsJhtEmployee],
    ["BPJS Kesehatan",reference.bpjsKesEmployee],["PPh21",reference.pph21],
    ["Potongan Lainnya",reference.otherDeductions],
  ])fireEvent.change(screen.getByLabelText(name),{target:{value}});
  fireEvent.change(screen.getByLabelText("Sumber komponen gaji"),{target:{value:"Catatan kasbon HR"}});
  const save=screen.getByRole("button",{name:"Simpan Gaji & Seluruh Potongan"});
  await waitFor(()=>expect((save as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(save);
  await screen.findByText(/Tujuh komponen tersimpan dan diverifikasi melalui baca ulang/);
  const puts=payloads.filter(x=>x.method==="PUT");
  expect(puts).toHaveLength(1);
  expect(puts[0].path).toBe("/api/payroll/components/61");
  expect(puts[0].body).toMatchObject(reference);
  expect(puts[0].body.notes).toBe("Catatan kasbon HR");
  expect(payloads.filter(x=>x.method!=="GET"&&x.method!=="PUT")).toHaveLength(0);
 });
});
