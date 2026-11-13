import {afterEach,beforeEach,describe,expect,it} from "vitest";
import {scanEmployeeDocument} from "./hrd-document-ocr";

const keys=["APP_ENV","HRD_PROD_OCR_LOCAL_ENABLED","HRD_PROD_OCR_OPENAI_FALLBACK_ENABLED","HRD_PROD_OPENAI_API_KEY"] as const;
const saved=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
const local=async()=>({text:"NAMA LENGKAP: QA SISTEM",confidence:0.68,source:"tesseract" as const,warnings:[]});
const provider=async()=>new Response(JSON.stringify({output_text:JSON.stringify({
 fields:{nama_lengkap:"QA SISTEM",nomor_dokumen:"123456789012",jenis_sim:"A",masa_berlaku:"2030-12-31"},
 confidence:0.82,warnings:[]
})}),{status:200,headers:{"content-type":"application/json"}});

describe("HRD consented managed OpenAI fallback",()=>{
 beforeEach(()=>{
  process.env.APP_ENV="production";
  process.env.HRD_PROD_OCR_LOCAL_ENABLED="true";
  process.env.HRD_PROD_OCR_OPENAI_FALLBACK_ENABLED="true";
  delete process.env.HRD_PROD_OPENAI_API_KEY;
 });
 afterEach(()=>{
  for(const key of keys){const value=saved[key]; if(value===undefined)delete process.env[key];else process.env[key]=value;}
 });
 it("reads existing managed key only after local OCR is incomplete",async()=>{
  let requested=0,called=0;
  const result=await scanEmployeeDocument(Buffer.from("fixture"),"image/png","sim",
   local,async(...args)=>{called++;return provider(...args);},
   async(key)=>{expect(key).toBe("OPENAI_API_KEY");requested++;return "fixture-credential";});
  expect(result.engine).toBe("openai_fallback");
  expect(result.fields.nomor_dokumen).toBe("123456789012");
  expect(result.fields.jenis_sim).toBe("A");
  expect(requested).toBe(1);
  expect(called).toBe(1);
  expect(JSON.stringify(result)).not.toContain("fixture-credential");
 });
 it("never calls shared credentials or provider when fallback is disabled",async()=>{
  process.env.HRD_PROD_OCR_OPENAI_FALLBACK_ENABLED="false";
  const result=await scanEmployeeDocument(Buffer.from("fixture"),"image/png","sim",
   local,async()=>{throw Error("PROVIDER_MUST_NOT_RUN");},
   async()=>{throw Error("KEY_MUST_NOT_BE_READ");});
  expect(result.engine).toBe("local_manual_review");
 });
 it("preserves incomplete local OCR when the managed credential cannot be read",async()=>{
  const result=await scanEmployeeDocument(Buffer.from("fixture"),"image/png","sim",
   local,async()=>{throw Error("PROVIDER_MUST_NOT_RUN");},
   async()=>{throw Error("MANAGED_CONFIG_UNAVAILABLE");});
  expect(result.engine).toBe("local_manual_review");
  expect(result.fields.nama_lengkap).toBe("QA SISTEM");
 });
 it("dedicated HRD credential has priority over the shared resolver",async()=>{
  process.env.HRD_PROD_OPENAI_API_KEY="fixture-dedicated";
  const result=await scanEmployeeDocument(Buffer.from("fixture"),"image/png","sim",
   local,provider,async()=>{throw Error("SHARED_RESOLVER_MUST_NOT_RUN");});
  expect(result.engine).toBe("openai_fallback");
 });
 it("does not use OpenAI when local extraction is already complete",async()=>{
  const result=await scanEmployeeDocument(Buffer.from("fixture"),"image/png","sim",
   async()=>({text:"NOMOR SIM: 123456789012\nNAMA LENGKAP: QA SISTEM\nGOLONGAN SIM: A\nBERLAKU SAMPAI: 31-12-2030",confidence:0.9,source:"tesseract",warnings:[]}),
   async()=>{throw Error("PROVIDER_MUST_NOT_RUN");},
   async()=>{throw Error("SHARED_RESOLVER_MUST_NOT_RUN");});
  expect(result.engine).toBe("local");
 });
});