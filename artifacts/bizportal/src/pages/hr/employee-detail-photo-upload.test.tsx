// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { compressImageFile } from "../../shared/object-storage-web/compressImage";

const fixture = vi.hoisted(() => ({ companyId: 1 }));
vi.mock("wouter", () => ({
  useRoute: () => [true, {id:"7"}],
  Link: ({children,href}:{children:React.ReactNode;href:string}) =>
    React.createElement("a",{href},children),
}));
vi.mock("@/contexts/CompanyContext", () => ({
  useCompany: () => ({activeCompanyId:fixture.companyId,isConsolidated:false}),
}));
vi.mock("@/components/layout/AppShell", () => ({
  AppShell: ({children}:{children:React.ReactNode}) => React.createElement("main",null,children),
}));
vi.mock("./hrd-document-manager", () => ({
  HrdDocumentManager: () => React.createElement("section",{"data-testid":"untouched-ocr-manager"}),
}));
vi.mock("../../shared/object-storage-web/compressImage", () => ({
  compressImageFile: vi.fn(),
}));
import HrdEmployeeDetailPage from "./employee-detail";

const BUCKET="bizportal-hrd-documents-prod";
const ORIGIN="https://nzdweipzckfszczzqtuw.supabase.co";
const DOCUMENT_ID="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const photo=(size:number,mime="image/jpeg") =>
  new File([new Uint8Array(size)],"synthetic-pas-foto.jpg",{type:mime});
const json=(data:unknown,status=200) =>
  new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json"}});
function employeeDetail(){
  return {
    companyId:1,employeeId:7,
    employee:{id:7,company_id:1,first_name:"Synthetic",last_name:"HRD",
      position:null,status:"active",email:null},
    verifiedProfile:{},documents:[],audit:[],
    photoUploadEnabled:true,ocrEnabled:true,
  };
}

describe("HRD Pas Foto signed-upload synthetic browser integration",()=>{
  const received:{mime?:string;file?:File;path?:string;complete?:boolean}={};
  let fetcher:ReturnType<typeof vi.fn>;
  beforeEach(()=>{
    fixture.companyId=1;
    Object.keys(received).forEach(key=>delete (received as Record<string,unknown>)[key]);
    Object.defineProperty(URL,"createObjectURL",{
      configurable:true,writable:true,value:vi.fn(()=> "blob:synthetic-preview"),
    });
    Object.defineProperty(URL,"revokeObjectURL",{
      configurable:true,writable:true,value:vi.fn(),
    });
    fetcher=vi.fn(async(input:string,init?:RequestInit)=>{
      const target=String(input);
      if(target==="/api/hrd/employees/7?companyId=1")return json(employeeDetail());
      if(target.includes("/photo/prepare?companyId=1")){
        const body=JSON.parse(String(init?.body)) as {mimeType:string};
        received.mime=body.mimeType;
        const ext=body.mimeType==="image/webp"?"webp":
          body.mimeType==="image/png"?"png":"jpg";
        return json({
          companyId:1,employeeId:7,documentId:DOCUMENT_ID,
          storageUrl:ORIGIN,bucket:BUCKET,
          path:`1/7/${DOCUMENT_ID}.${ext}`,token:"synthetic-only-token",maxBytes:5242880,
        },201);
      }
      if(target.startsWith(ORIGIN+"/storage/v1/object/upload/sign/")){
        expect(init?.method).toBe("PUT");
        expect((init?.headers as Record<string,string>)["x-upsert"]).toBe("false");
        const parts=[...((init?.body as FormData).entries())];
        expect(parts.map(([name])=>name)).toEqual(["cacheControl",""]);
        received.file=parts[1][1] as File;
        received.path=new URL(target).pathname;
        return json({Key:"synthetic-only"});
      }
      if(target.includes("/photo/"+DOCUMENT_ID+"/complete?companyId=1")){
        received.complete=true;
        return json({status:"pending_review"});
      }
      throw Error("Unexpected synthetic HRD URL: "+target);
    });
    vi.stubGlobal("fetch",fetcher);
  });
  afterEach(()=>{
    cleanup();
    vi.unstubAllGlobals();
    delete (URL as unknown as Record<string,unknown>).createObjectURL;
    delete (URL as unknown as Record<string,unknown>).revokeObjectURL;
  });

  async function upload(original:File){
    render(<HrdEmployeeDetailPage />);
    await screen.findByText("Synthetic HRD");
    expect(screen.getByTestId("untouched-ocr-manager")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Ambil Pas Foto atau pilih dari galeri"),{
      target:{files:[original]},
    });
    fireEvent.click(screen.getByRole("button",{name:"Unggah Pas Foto Privat"}));
    await waitFor(()=>expect(received.complete).toBe(true));
  }

  it("uploads the smaller WebP file via the existing private signed PUT, with matching MIME and path",async()=>{
    const original=photo(360*1024);
    const optimized=new File([new Uint8Array(115*1024)],"synthetic-pas-foto.webp",{type:"image/webp"});
    vi.mocked(compressImageFile).mockResolvedValue(optimized);
    await upload(original);
    expect(compressImageFile).toHaveBeenCalledWith(original,"photo");
    expect(received.mime).toBe("image/webp");
    expect(received.file?.size).toBe(optimized.size);
    expect(received.file?.type).toBe("image/webp");
    expect(received.path).toBe("/storage/v1/object/upload/sign/"+BUCKET+"/1/7/"+DOCUMENT_ID+".webp");
    expect(screen.getByText(/Pas Foto berhasil dikompresi/)).toBeTruthy();
    expect(original.size).toBe(360*1024);
  });

  it("keeps existing signed-upload behavior when the browser's compressor is unavailable",async()=>{
    const original=photo(180*1024);
    vi.mocked(compressImageFile).mockRejectedValue(new Error("Synthetic canvas unavailable"));
    await upload(original);
    expect(received.mime).toBe("image/jpeg");
    expect(received.file?.size).toBe(original.size);
    expect(received.path).toBe("/storage/v1/object/upload/sign/"+BUCKET+"/1/7/"+DOCUMENT_ID+".jpg");
    expect(screen.getByText("Pas Foto tersimpan secara privat dan menunggu verifikasi HRD.")).toBeTruthy();
  });
});
