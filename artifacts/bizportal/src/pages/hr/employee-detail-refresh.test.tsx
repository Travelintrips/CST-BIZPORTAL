// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const fixture = vi.hoisted(() => ({
  activeCompanyId: 1,
  mounts: 0,
  unmounts: 0,
}));
vi.mock("wouter", () => ({
  useRoute: () => [true, {id:"7"}],
  Link: ({children,href}:{children:React.ReactNode;href:string}) =>
    React.createElement("a",{href},children),
}));
vi.mock("@/contexts/CompanyContext", () => ({
  useCompany: () => ({activeCompanyId:fixture.activeCompanyId,isConsolidated:false}),
}));
vi.mock("@/components/layout/AppShell", () => ({
  AppShell: ({children}:{children:React.ReactNode}) => React.createElement("main",null,children),
}));
vi.mock("./hrd-document-manager", () => ({
  HrdDocumentManager: ({refresh}:{refresh:()=>Promise<void>}) => {
    const [draft,setDraft] = React.useState("Unsent HRD correction");
    React.useEffect(() => {
      fixture.mounts++;
      return () => {fixture.unmounts++;};
    },[]);
    return React.createElement("div",{"data-testid":"hrd-reviewer"},
      React.createElement("input",{
        "aria-label":"HRD draft correction",value:draft,
        onChange:(e:React.ChangeEvent<HTMLInputElement>)=>setDraft(e.target.value),
      }),
      React.createElement("button",{onClick:()=>void refresh()},"Refresh mock HRD"),
    );
  },
}));
import HrdEmployeeDetailPage from "./employee-detail";

function detail(companyId:number,name:string){
  return {
    companyId,employeeId:7,
    employee:{id:7,company_id:companyId,first_name:name,last_name:"",
      position:null,status:"active",email:null},
    verifiedProfile:{},documents:[],audit:[],
    photoUploadEnabled:false,ocrEnabled:true,
  };
}
const result=(companyId:number,name:string) =>
  new Response(JSON.stringify(detail(companyId,name)),{
    status:200,headers:{"Content-Type":"application/json"},
  });

describe("HRD employee detail review persistence and tenant privacy",()=>{
  beforeEach(()=>{fixture.activeCompanyId=1;fixture.mounts=0;fixture.unmounts=0;});
  afterEach(()=>{cleanup();vi.unstubAllGlobals();});
  it("preserves the same employee's unsaved OCR correction through a successful refresh",async()=>{
    let resolveRefresh:(value:Response)=>void=()=>{};
    const pendingRefresh=new Promise<Response>((resolve)=>{resolveRefresh=resolve;});
    const fetcher=vi.fn().mockResolvedValueOnce(result(1,"Synthetic Employee One"))
      .mockImplementationOnce(()=>pendingRefresh);
    vi.stubGlobal("fetch",fetcher);
    render(<HrdEmployeeDetailPage />);
    const draft=await screen.findByRole("textbox",{name:"HRD draft correction"});
    fireEvent.change(draft,{target:{value:"Human reviewed correction"}});
    fireEvent.click(screen.getByRole("button",{name:"Refresh mock HRD"}));
    // The old implementation set detail=null and unmounted the review form.
    expect(screen.getByRole("textbox",{name:"HRD draft correction"})).toHaveProperty("value","Human reviewed correction");
    expect(fixture.mounts).toBe(1);
    expect(fixture.unmounts).toBe(0);
    resolveRefresh(result(1,"Synthetic Employee Revised"));
    await screen.findByText("Synthetic Employee Revised");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("textbox",{name:"HRD draft correction"})).toHaveProperty("value","Human reviewed correction");
    expect(fixture.mounts).toBe(1);
    expect(fixture.unmounts).toBe(0);
  });
  it("immediately hides the old company's employee when tenant selection changes",async()=>{
    let resolveNext:(value:Response)=>void=()=>{};
    const nextCompany=new Promise<Response>(resolve=>{resolveNext=resolve;});
    const fetcher=vi.fn().mockResolvedValueOnce(result(1,"First Company Employee"))
      .mockImplementationOnce(()=>nextCompany);
    vi.stubGlobal("fetch",fetcher);
    const view=render(<HrdEmployeeDetailPage />);
    await screen.findByText("First Company Employee");
    fixture.activeCompanyId=3;
    view.rerender(<HrdEmployeeDetailPage />);
    expect(screen.queryByText("First Company Employee")).toBeNull();
    expect(screen.queryByTestId("hrd-reviewer")).toBeNull();
    resolveNext(result(3,"Third Company Employee"));
    await screen.findByText("Third Company Employee");
    expect(screen.queryByText("First Company Employee")).toBeNull();
  });
});
