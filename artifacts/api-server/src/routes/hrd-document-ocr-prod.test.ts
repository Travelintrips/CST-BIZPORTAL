import {afterEach,describe,expect,it} from "vitest";
import {hrdOcrReady,hrdBucketName} from "./hrd-document-ocr";

const keys=[
 "APP_ENV","HRD_PROD_OCR_ENABLED","HRD_PROD_SUPABASE_URL",
 "HRD_PROD_STORAGE_SERVICE_KEY","SUPABASE_URL","SUPABASE_SERVICE_ROLE_KEY",
 "HRD_PROD_OCR_LOCAL_ENABLED","HRD_PROD_OCR_OPENAI_FALLBACK_ENABLED",
 "HRD_PROD_OPENAI_API_KEY","OPENAI_API_KEY",
] as const;
const previous=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
afterEach(()=>{for(const key of keys){const value=previous[key];if(value===undefined)delete process.env[key];else process.env[key]=value;}});

describe("HRD OCR PROD environment isolation",()=>{
 it("stays disabled unless the explicit production feature flag is enabled",()=>{
  process.env.APP_ENV="production";
  process.env.HRD_PROD_OCR_ENABLED="false";
  process.env.SUPABASE_URL="https://nzdweipzckfszczzqtuw.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY="test-only-service-key";
  expect(hrdOcrReady()).toBe(false);
 });
 it("accepts the pinned PROD Supabase project with local OCR and no OpenAI key",()=>{
  process.env.APP_ENV="production";
  process.env.HRD_PROD_OCR_ENABLED="true";
  process.env.SUPABASE_URL="https://nzdweipzckfszczzqtuw.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY="test-only-service-key";
  process.env.HRD_PROD_OCR_LOCAL_ENABLED="true";
  delete process.env.OPENAI_API_KEY;
  delete process.env.HRD_PROD_OPENAI_API_KEY;
  expect(hrdOcrReady()).toBe(true);
  expect(hrdBucketName()).toBe("bizportal-hrd-documents-prod");
 });
 it("rejects the DEV Supabase project in PROD",()=>{
  process.env.APP_ENV="production";
  process.env.HRD_PROD_OCR_ENABLED="true";
  process.env.SUPABASE_URL="https://xssrfshdrtdfupgqwfdw.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY="test-only-service-key";
  expect(hrdOcrReady()).toBe(false);
 });
});
