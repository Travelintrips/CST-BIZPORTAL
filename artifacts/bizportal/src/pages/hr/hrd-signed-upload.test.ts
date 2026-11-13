// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildHrdSignedUploadUrl, hashHrdOriginalFile, uploadHrdSignedDocument, type HrdSignedUpload } from "./hrd-signed-upload";

const base:HrdSignedUpload={
  companyId:1,
  employeeId:7,
  documentId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  bucket:"bizportal-hrd-documents-prod",
  storageUrl:"https://nzdweipzckfszczzqtuw.supabase.co",
  path:"1/7/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jpg",
  token:"synthetic.token-123",
  maxBytes:5242880,
};
const image=()=>new File([new Uint8Array([255,216,255,1,2,3])],"fixture.jpg",{type:"image/jpeg"});

afterEach(()=>vi.unstubAllGlobals());

describe("HRD signed Storage upload browser contract",()=>{
  it("computes a normalized SHA-256 digest from the exact original file in memory",async()=>{
    const bytes=new Uint8Array([255,216,255,1,2,3]);
    const imageFile=image();
    Object.defineProperty(imageFile,"arrayBuffer",{value:async()=>bytes.buffer});
    const seen:{algorithm?:string}={};
    vi.stubGlobal("crypto",{subtle:{digest:async(algorithm:string,buffer:ArrayBuffer)=>{
      seen.algorithm=algorithm;
      expect(Array.from(new Uint8Array(buffer))).toEqual(Array.from(bytes));
      return new Uint8Array(32).fill(0xab).buffer;
    }}});
    expect(await hashHrdOriginalFile(imageFile)).toBe("ab".repeat(32));
    expect(seen.algorithm).toBe("SHA-256");
    expect(imageFile.size).toBe(bytes.length);
  });
  it("preserves existing upload behavior if browser crypto hashing is unsupported",async()=>{
    vi.stubGlobal("crypto",{});
    expect(await hashHrdOriginalFile(image())).toBeNull();
  });
  it("sends exact Supabase-compatible PUT multipart without a service credential",async()=>{
    const fn=vi.fn().mockResolvedValue({ok:true,status:200});
    vi.stubGlobal("fetch",fn);
    await uploadHrdSignedDocument(base,image(),1,7);
    expect(fn).toHaveBeenCalledTimes(1);
    const [url,options]=fn.mock.calls[0] as [string,RequestInit];
    const parsed=new URL(url);
    expect(parsed.origin).toBe("https://nzdweipzckfszczzqtuw.supabase.co");
    expect(parsed.pathname).toBe(
      "/storage/v1/object/upload/sign/bizportal-hrd-documents-prod/"+
      "1/7/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jpg",
    );
    expect(parsed.searchParams.get("token")).toBe(base.token);
    expect(options.method).toBe("PUT");
    expect(options.headers).toEqual({"x-upsert":"false"});
    expect(options.body).toBeInstanceOf(FormData);
    const entries=[...(options.body as FormData).entries()];
    expect(entries.map(([k])=>k)).toEqual(["cacheControl",""]);
    expect(entries[0][1]).toBe("3600");
    expect(entries[1][1]).toBeInstanceOf(File);
    expect(options.headers).not.toHaveProperty("Authorization");
    expect(options.headers).not.toHaveProperty("apikey");
  });

  it("rejects cross-company, wrong employee, foreign storage, and malformed signed path before network",async()=>{
    const fn=vi.fn();
    vi.stubGlobal("fetch",fn);
    const bad=[
      {...base,companyId:3},
      {...base,employeeId:8},
      {...base,storageUrl:"https://xssrfshdrtdfupgqwfdw.supabase.co"},
      {...base,bucket:"public"},
      {...base,path:"3/7/"+base.documentId+".jpg"},
      {...base,path:"1/7/../../other.jpg"},
      {...base,path:"1/7/"+base.documentId+".pdf"},
      {...base,token:""},
      {...base,maxBytes:5242881},
    ];
    for(const signed of bad) {
      await expect(uploadHrdSignedDocument(signed,image(),1,7)).rejects.toThrow();
    }
    expect(fn).not.toHaveBeenCalled();
  });

  it("prevents an oversized file or MIME/extension mismatch before signing is consumed",()=>{
    const pdf=new File([new Uint8Array([37,80,68,70,45])],"sample.pdf",{type:"application/pdf"});
    expect(()=>buildHrdSignedUploadUrl(base,pdf,1,7)).toThrow();
    expect(()=>buildHrdSignedUploadUrl({...base,maxBytes:2},image(),1,7)).toThrow();
  });

  it("rejects HTTP failures without treating the file as uploaded",async()=>{
    const fn=vi.fn().mockResolvedValue({ok:false,status:403});
    vi.stubGlobal("fetch",fn);
    await expect(uploadHrdSignedDocument(base,image(),1,7)).rejects.toThrow("Upload privat gagal");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
