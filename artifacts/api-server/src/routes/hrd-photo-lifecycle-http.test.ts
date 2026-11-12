import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Request, type Response } from "express";
import { createServer, type Server } from "node:http";
import { once } from "node:events";

const fixture = vi.hoisted(() => ({
  companyId: 1,
  documents: new Map<string, {id:string; companyId:number; employeeId:number;
    mime:string;path:string;status:string;hash:string|null}>(),
  audit: [] as string[],
  queries: [] as Array<{sql:string;values:unknown[]}>,
  object: Buffer.from([255,216,255,1,2,3,4]),
  enabled: true,
}));
vi.mock("./hrd-db", () => ({
  withHrdCompanyScope: async <T>(companyId: number,
    fn: (client:{query:(sql:string,values?:unknown[])=>Promise<unknown>})=>Promise<T>) => {
    if (companyId !== fixture.companyId) throw Error("TENANT_SCOPE_INVALID");
    const client = {
      query: async (sql:string,values:unknown[] = []) => {
        fixture.queries.push({sql,values});
        if (sql.includes("SELECT id FROM public.employees"))
          return {rows:[{id:7}],rowCount:1};
        if (sql.includes("INSERT INTO hrd_private.employee_documents")) {
          const [id,companyId,employeeId,,mime,path] = values as [string,number,number,string,string,string];
          fixture.documents.set(id,{id,companyId,employeeId,mime,path,status:"upload_pending",hash:null});
          return {rows:[],rowCount:1};
        }
        if (sql.includes("INSERT INTO hrd_private.employee_document_audit")) {
          fixture.audit.push(sql);
          return {rows:[],rowCount:1};
        }
        if (sql.includes("SELECT id,mime_type,storage_path")) {
          const d=fixture.documents.get(String(values[0]));
          return d&&d.companyId===values[1]&&d.employeeId===values[2]&&d.status==="upload_pending"
            ?{rows:[{id:d.id,mime_type:d.mime,storage_path:d.path}],rowCount:1}
            :{rows:[],rowCount:0};
        }
        if (sql.includes("SET status='pending_review'")) {
          const d=fixture.documents.get(String(values[1]));
          if(!d||d.status!=="upload_pending"||d.companyId!==values[2]||d.employeeId!==values[3])
            return {rows:[],rowCount:0};
          d.hash=String(values[0]);d.status="pending_review";
          return {rows:[{id:d.id}],rowCount:1};
        }
        if (sql.includes("SET status='verified'")) {
          const d=fixture.documents.get(String(values[1]));
          if(!d||d.status!=="pending_review"||d.companyId!==values[2]||d.employeeId!==values[3]||!d.hash)
            return {rows:[],rowCount:0};
          d.status="verified";
          return {rows:[{id:d.id}],rowCount:1};
        }
        if (sql.includes("SELECT storage_path")) {
          const d=fixture.documents.get(String(values[0]));
          return d&&d.companyId===values[1]&&d.employeeId===values[2]&&
            (d.status==="pending_review"||d.status==="verified")
            ?{rows:[{storage_path:d.path}],rowCount:1}:{rows:[],rowCount:0};
        }
        throw Error("Unexpected synthetic HRD SQL");
      },
    };
    return await fn(client);
  },
}));
vi.mock("./hrd-photo-storage", () => ({
  hrdPrivateStorageReady: () => fixture.enabled,
  createHrdPhotoSignedUpload: async (path:string) => ({
    storageUrl:"https://nzdweipzckfszczzqtuw.supabase.co",
    bucket:"bizportal-hrd-documents-prod",path,token:"synthetic-signed-upload",
  }),
  readHrdPhoto: async () => fixture.object,
  validPhotoMime: (v:unknown) => ["image/jpeg","image/png","image/webp"].includes(String(v)),
  validPhotoBytes: (bytes:Buffer,mime:string) =>
    mime==="image/jpeg"&&bytes.length>3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255,
  photoSha256: () => "a".repeat(64),
  signHrdPhotoPreview: async (path:string) => ({
    url:"https://nzdweipzckfszczzqtuw.supabase.co/storage/v1/object/sign/bizportal-hrd-documents-prod/"+
      path+"?token=synthetic-preview",expiresIn:60,
  }),
}));
import { registerHrdPhotoRoutes } from "./hrd-photo-routes";

describe("HRD Pas Foto synthetic HTTP lifecycle (no production writes)",()=>{
  let server:Server;
  let origin:string;
  const req = async (route:string,body:unknown={}) => {
    const response=await fetch(origin+"/api/hrd/employees/7/photo/"+route,{
      method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body),
    });
    return {status:response.status,json:await response.json() as Record<string,unknown>};
  };
  beforeAll(async()=>{
    const router=express.Router();
    router.use((request:Request,_response:Response,next)=>{
      (request as Request & {hrdCompanyId:number;hrdActor:{email:string}}).hrdCompanyId=fixture.companyId;
      (request as Request & {hrdCompanyId:number;hrdActor:{email:string}}).hrdActor={email:"synthetic@example.test"};
      next();
    });
    registerHrdPhotoRoutes(router);
    const app=express();app.use(express.json());app.use("/api",router);
    server=createServer(app);server.listen(0,"127.0.0.1");await once(server,"listening");
    const address=server.address();
    if(!address||typeof address==="string")throw Error("Missing test port");
    origin="http://127.0.0.1:"+address.port;
  });
  afterAll(async()=>{if(server)await new Promise<void>((resolve,reject)=>
    server.close(error=>error?reject(error):resolve()));});
  beforeEach(()=>{
    fixture.companyId=1;fixture.enabled=true;
    fixture.documents.clear();fixture.audit.length=0;fixture.queries.length=0;
    fixture.object=Buffer.from([255,216,255,1,2,3,4]);
  });
  it("prepare → complete → verify → preview, with audit and replay rejection",async()=>{
    const prepared=await req("prepare",{mimeType:"image/jpeg",processingAuthorizationConfirmed:true});
    expect(prepared.status).toBe(201);
    const id=String(prepared.json.documentId);
    expect(prepared.json).toMatchObject({
      companyId:1,employeeId:7,bucket:"bizportal-hrd-documents-prod",
      token:"synthetic-signed-upload",
    });
    expect(prepared.json).not.toHaveProperty("service_role_key");
    const completed=await req(id+"/complete");
    expect(completed.status).toBe(200);
    expect(completed.json.status).toBe("pending_review");
    expect((await req(id+"/complete")).status).toBe(409);
    const preview=await req(id+"/preview");
    expect(preview.status).toBe(200);
    expect(preview.json.expiresIn).toBe(60);
    const verified=await req(id+"/verify",{confirm:true});
    expect(verified.status).toBe(200);
    expect(verified.json.status).toBe("verified");
    expect((await req(id+"/verify",{confirm:true})).status).toBe(409);
    expect(fixture.documents.get(id)?.status).toBe("verified");
    expect(fixture.audit).toHaveLength(3);
  });
  it("does not complete a photo with content spoofing",async()=>{
    const prepared=await req("prepare",{mimeType:"image/jpeg",processingAuthorizationConfirmed:true});
    const id=String(prepared.json.documentId);
    fixture.object=Buffer.from("%PDF-1.7");
    expect((await req(id+"/complete")).status).toBe(400);
    expect(fixture.documents.get(id)?.status).toBe("upload_pending");
    expect(fixture.audit).toHaveLength(1);
  });
  it("rejects foreign employee or company id without modifying document",async()=>{
    const prepared=await req("prepare",{mimeType:"image/jpeg",processingAuthorizationConfirmed:true});
    const id=String(prepared.json.documentId);
    const response=await fetch(origin+"/api/hrd/employees/8/photo/"+id+"/complete",{
      method:"POST",headers:{"content-type":"application/json"},body:"{}",
    });
    expect(response.status).toBe(409);
    expect(fixture.documents.get(id)?.status).toBe("upload_pending");
  });
  it("stays unavailable with production storage flag off",async()=>{
    fixture.enabled=false;
    const response=await req("prepare",{mimeType:"image/jpeg",processingAuthorizationConfirmed:true});
    expect(response.status).toBe(503);
    expect(fixture.queries).toHaveLength(0);
  });
});
