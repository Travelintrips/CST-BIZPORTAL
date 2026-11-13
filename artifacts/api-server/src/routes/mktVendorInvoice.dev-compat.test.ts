import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from "vitest";
import express from "express";
import type {Server} from "node:http";
import type {AddressInfo} from "node:net";
const mocks=vi.hoisted(()=>({findPo:vi.fn(),create:vi.fn(),query:vi.fn(),delete:vi.fn(),upload:vi.fn()}));
vi.mock("../lib/services/mktVendorPoTokenService.js",()=>({findPoByVendorToken:mocks.findPo}));
vi.mock("../lib/uploadMiddleware.js",()=>({imagePdfUpload:()=>({single:()=> (_req:any,_res:any,next:()=>void)=>next()}),sanitizeFilename:(name:string)=>name}));
vi.mock("../lib/uploadValidation.js",()=>({validateMagicBytes:()=>({ok:true})}));
vi.mock("../lib/objectStorage.js",()=>({ObjectStorageService:class{uploadPrivateEntity=mocks.upload;tryDeletePrivateEntity=mocks.delete}}));
vi.mock("../lib/middleware/validateBody.js",()=>({validateBody:()=> (_req:any,_res:any,next:()=>void)=>next()}));
vi.mock("../middlewares/securityRateLimiter.js",()=>({tokenGetRateLimiter:(_req:any,_res:any,next:()=>void)=>next(),tokenPostRateLimiter:(_req:any,_res:any,next:()=>void)=>next()}));
vi.mock("../lib/services/mktVendorInvoiceService.js",()=>({createMarketplaceVendorInvoice:mocks.create,getMarketplaceVendorInvoice:vi.fn(),safeMarketplaceVendorInvoiceView:vi.fn(),submitMarketplaceVendorInvoice:vi.fn()}));
vi.mock("@workspace/db",()=>({db:{select:mocks.query}}));
vi.mock("../lib/logger.js",()=>({logger:{warn:vi.fn(),info:vi.fn()}}));
import router from "./mktVendorInvoice";
let server:Server,base:string;
beforeAll(async()=>{const app=express();app.use(express.json());app.use("/api/mkt/vendor-invoice",router);server=app.listen(0);await new Promise<void>(r=>server.once("listening",r));base="http://127.0.0.1:"+(server.address() as AddressInfo).port});
afterAll(async()=>{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()))});
beforeEach(()=>{for(const v of Object.values(mocks))v.mockReset()});
describe("original vendor invoice route preserved with null-company guard",()=>{
 it("rejects historical PO without company before any DB or Storage write",async()=>{
  mocks.findPo.mockResolvedValue({ok:true,po:{id:2,companyId:null,vendorId:9}});
  const res=await fetch(base+"/api/mkt/vendor-invoice/opaque-test-token",{method:"POST"});
  expect(res.status).toBe(409);expect(((await res.json()) as {error:string}).error).toBe("COMPANY_OR_VENDOR_UNASSIGNED");
  expect(mocks.create).not.toHaveBeenCalled();expect(mocks.upload).not.toHaveBeenCalled();
 });
 it("rejects missing vendor ID before invoice upload",async()=>{
  mocks.findPo.mockResolvedValue({ok:true,po:{id:2,companyId:1,vendorId:null}});
  const res=await fetch(base+"/api/mkt/vendor-invoice/opaque-test-token",{method:"POST"});
  expect(res.status).toBe(409);expect(mocks.create).not.toHaveBeenCalled();
 });
 it("keeps existing vendor token rejection contract",async()=>{
  mocks.findPo.mockResolvedValue({ok:false,code:"EXPIRED"});
  const res=await fetch(base+"/api/mkt/vendor-invoice/expired-token",{method:"POST"});
  expect(res.status).toBe(410);expect(mocks.create).not.toHaveBeenCalled();
 });
 it("requires a real file after valid company-scoped token validation",async()=>{
  mocks.findPo.mockResolvedValue({ok:true,po:{id:3,companyId:1,vendorId:5}});
  const res=await fetch(base+"/api/mkt/vendor-invoice/valid-token",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({})});
  expect(res.status).toBe(422);expect(mocks.upload).not.toHaveBeenCalled();
 });
});
