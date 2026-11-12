import { afterEach, describe, expect, it, vi } from "vitest";
import { runHrdStorageCanary } from "./hrd-storage-canary";

const keys=[
  "APP_ENV","HRD_PROD_STORAGE_CANARY_ENABLED","HRD_PROD_DOCUMENTS_ENABLED",
  "HRD_PROD_OCR_ENABLED","HRD_PROD_SUPABASE_URL","HRD_PROD_STORAGE_SERVICE_KEY",
] as const;
const original=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
afterEach(()=>{
  for(const [key,value] of Object.entries(original)) {
    if(value===undefined)delete process.env[key];else process.env[key]=value;
  }
  vi.unstubAllGlobals();
});
const configure=()=>{
  process.env.APP_ENV="production";
  process.env.HRD_PROD_STORAGE_CANARY_ENABLED="true";
  process.env.HRD_PROD_DOCUMENTS_ENABLED="false";
  process.env.HRD_PROD_OCR_ENABLED="false";
  process.env.HRD_PROD_SUPABASE_URL="https://nzdweipzckfszczzqtuw.supabase.co";
  process.env.HRD_PROD_STORAGE_SERVICE_KEY="synthetic-test-key";
};

describe("HRD PROD synthetic storage canary (all network mocked)",()=>{
  it("does not touch network while opt-in is OFF or normal upload is enabled",async()=>{
    configure();
    process.env.HRD_PROD_STORAGE_CANARY_ENABLED="false";
    const fetcher=vi.fn();
    vi.stubGlobal("fetch",fetcher);
    expect((await runHrdStorageCanary()).ok).toBe(false);
    process.env.HRD_PROD_STORAGE_CANARY_ENABLED="true";
    process.env.HRD_PROD_DOCUMENTS_ENABLED="true";
    expect((await runHrdStorageCanary()).ok).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("signed upload -> readback -> 60s preview -> cleanup, without leaking key",async()=>{
    configure();
    const bytes=Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlB6X8AAAAASUVORK5CYII=",
      "base64",
    );
    const calls: Array<{url:string;method:string}>=[];
    const fetcher=vi.fn(async (url:string,opts?:{method?:string})=>{
      const method=opts?.method ?? "GET";
      calls.push({url,method});
      if(url.includes("/object/upload/sign/")&&method==="POST")
        return {ok:true,json:async()=>({token:"synthetic-upload"})};
      if(url.includes("/object/upload/sign/")&&method==="PUT")
        return {ok:true};
      if(url.includes("/object/authenticated/"))
        return {ok:true,arrayBuffer:async()=>Uint8Array.from(bytes).buffer};
      if(url.includes("/object/sign/")&&method==="POST")
        return {ok:true,json:async()=>({
          signedURL:url.replace("https://nzdweipzckfszczzqtuw.supabase.co/storage/v1","")+
            "?token=synthetic-preview",
        })};
      if(url.includes("/object/sign/")&&method==="GET")
        return {ok:true,arrayBuffer:async()=>Uint8Array.from(bytes).buffer};
      if(method==="DELETE")return {ok:true};
      throw Error("Unexpected synthetic request");
    });
    vi.stubGlobal("fetch",fetcher);
    const result=await runHrdStorageCanary();
    expect(result).toEqual({ok:true,uploaded:true,readback:true,preview:true,cleaned:true});
    expect(calls.map(x=>x.method)).toEqual(["POST","PUT","GET","POST","GET","DELETE"]);
    expect(JSON.stringify(result)).not.toContain("synthetic-test-key");
    expect(calls.every(c=>c.url.includes("_synthetic_canary/"))).toBe(true);
  });
  it("reports failure and still deletes after unsuccessful readback",async()=>{
    configure();
    const calls:string[]=[];
    vi.stubGlobal("fetch",vi.fn(async (url:string,opts?:{method?:string})=>{
      const method=opts?.method ?? "GET";calls.push(method);
      if(method==="POST")return {ok:true,json:async()=>({token:"synthetic-upload"})};
      if(method==="PUT")return {ok:true};
      if(url.includes("/object/authenticated/"))
        return {ok:false,status:404};
      if(method==="DELETE")return {ok:true};
      throw Error("Unexpected request");
    }));
    const result=await runHrdStorageCanary();
    expect(result.ok).toBe(false);
    expect(result.cleaned).toBe(true);
    expect(calls).toEqual(["POST","PUT","GET","DELETE"]);
  });
});
