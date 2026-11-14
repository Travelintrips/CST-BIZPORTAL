import React from "react";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";

const ctx=vi.hoisted(()=>({
  companyId:1 as number|null,
  consolidated:false,
  enabled:true,
  badTenant:false,
  navigations:[] as string[],
}));
vi.mock("@/contexts/CompanyContext",()=>({
  useCompany:()=>({
    activeCompanyId:ctx.companyId,
    isConsolidated:ctx.consolidated,
  })
}));
vi.mock("@/components/layout/AppShell",()=>({
  AppShell:({children}:{children:React.ReactNode})=><div>{children}</div>,
}));
vi.mock("wouter",()=>({
  Link:({children,href}:{children:React.ReactNode;href:string})=><a href={href}>{children}</a>,
  useLocation:()=>["/",(url:string)=>ctx.navigations.push(url)],
}));
import HrdEmployeeDirectory from "./employee-directory";

beforeEach(()=>{
  ctx.companyId=1;ctx.consolidated=false;ctx.enabled=true;ctx.badTenant=false;
  ctx.navigations.length=0;
  vi.stubGlobal("fetch",vi.fn(async()=>{
    return {
      ok:true,
      json:async()=>({
        companyId:ctx.badTenant?3:1,
        statusChangeEnabled:ctx.enabled,
        employees:[
          {id:61,company_id:1,first_name:"QA",last_name:"Aktif",status:"active",email:"active@example.test",phone:null,position:null,hire_date:null},
          {id:62,company_id:1,first_name:"QA",last_name:"Lama",status:"inactive",email:"inactive@example.test",phone:null,position:null,hire_date:null},
        ],
      })
    } as Response;
  }));
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});

describe("Existing HRD directory resignation action",()=>{
  it("shows action for active employee and navigates to existing confirmation, never mutates",async()=>{
    render(<HrdEmployeeDirectory/>);
    const action=await screen.findByRole("button",{name:"Nonaktifkan (Resign)"});
    expect((action as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText("Sudah nonaktif")).toBeTruthy();
    fireEvent.click(action);
    expect(ctx.navigations).toEqual(["/hr/employees/61"]);
    const requests=(globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(requests).toHaveLength(1);
    expect(requests[0][0]).toBe("/api/hrd/employees?companyId=1");
    expect(requests.every(call=>!call[1]||call[1].method===undefined||call[1].method==="GET")).toBe(true);
  });
  it("shortcut remains clickable and explains disabled backend even if server capability is false",async()=>{
    ctx.enabled=false;
    render(<HrdEmployeeDirectory/>);
    const action=await screen.findByRole("button",{name:"Nonaktifkan (Resign)"});
    expect((action as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText(/Pengelolaan status HRD sedang nonaktif di server/i)).toBeTruthy();
    fireEvent.click(action);
    expect(ctx.navigations).toEqual(["/hr/employees/61"]);
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });
  it("filters active versus inactive without mutating either status",async()=>{
    render(<HrdEmployeeDirectory/>);
    await screen.findByText("QA Aktif");
    fireEvent.click(screen.getByRole("button",{name:"Nonaktif (1)"}));
    await waitFor(()=>expect(screen.queryByText("QA Aktif")).toBeNull());
    expect(screen.getByText("QA Lama")).toBeTruthy();
    expect(screen.queryByRole("button",{name:"Nonaktifkan (Resign)"})).toBeNull();
    expect(ctx.navigations).toHaveLength(0);
  });
  it("never shows cross-company employee data after a wrong-tenant response",async()=>{
    ctx.badTenant=true;
    render(<HrdEmployeeDirectory/>);
    expect(await screen.findByText(/Scope perusahaan tidak cocok/)).toBeTruthy();
    expect(screen.queryByRole("button",{name:"Nonaktifkan (Resign)"})).toBeNull();
    expect(ctx.navigations).toHaveLength(0);
  });
});
