import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import { once } from "node:events";

type FixtureDoc = { id:string; companyId:number; employeeId:number; docType:string;
  mime:string; path:string; status:string; stale?:boolean; extracted:Record<string,string|null>; verified:Record<string,string|null>|null };
const state = vi.hoisted(() => ({
  docs: new Map<string,FixtureDoc>(),
  audit: [] as string[],
  profile: null as Record<string,string|null>|null,
  duplicatedNik: false,
  validBytes: true,
  tenant: 1,
  actor: "synthetic-hrd@example.test",
}));
vi.mock("./hrd-db",()=>({
  withHrdCompanyScope: async <T>(companyId:number, work:(client:{query:(sql:string,values?:unknown[])=>Promise<unknown>})=>Promise<T>)=>{
    if(companyId!==state.tenant)throw Error("TENANT_INVALID");
    return work({query:async(sql:string,v:unknown[]=[])=>{
      if(sql.includes("FROM public.employees"))return {rowCount:1,rows:[{id:7}]};
      if(sql.includes("INSERT INTO hrd_private.employee_documents")){
        const [id,companyId,employeeId,type,mime,path]=v as [string,number,number,string,string,string];
        state.docs.set(id,{id,companyId,employeeId,docType:type,mime,path,
          status:"upload_pending",extracted:{},verified:null});
        return {rowCount:1,rows:[]};
      }
      if(sql.includes("INSERT INTO hrd_private.employee_document_audit")){
        state.audit.push(sql);
        return {rowCount:1,rows:[]};
      }
      if(sql.includes("SET status='scanning'")){
        const d=state.docs.get(String(v[0]));
        if(!d||!(d.status==="upload_pending"||d.status==="scan_failed"||(d.status==="scanning"&&d.stale))||d.companyId!==v[1]||d.employeeId!==v[2])
          return {rowCount:0,rows:[]};
        d.status="scanning";
        return {rowCount:1,rows:[{...d,doc_type:d.docType,mime_type:d.mime,storage_path:d.path}]};
      }
      if(sql.includes("SET status='pending_review'")){
        const d=state.docs.get(String(v[4]));
        if(!d||d.status!=="scanning"||d.companyId!==v[5]||d.employeeId!==v[6])
          return {rowCount:0,rows:[]};
        d.status="pending_review";d.extracted=JSON.parse(String(v[0]));
        return {rowCount:1,rows:[{id:d.id}]};
      }
      if(sql.includes("SET status='scan_failed'")){
        const d=state.docs.get(String(v[0]));
        if(!d||d.status!=="scanning")return {rowCount:0,rows:[]};
        d.status="scan_failed";
        return {rowCount:1,rows:[{id:d.id}]};
      }
      if(sql.includes("FOR UPDATE")){
        const d=state.docs.get(String(v[0]));
        return d&&d.companyId===v[1]&&d.employeeId===v[2]
          ?{rowCount:1,rows:[{id:d.id,status:d.status,doc_type:d.docType}]}
          :{rowCount:0,rows:[]};
      }
      if(sql.includes("employee_profiles")&&sql.includes("verified_data->>'nik'")){
        return state.duplicatedNik?{rowCount:1,rows:[{employee_id:999}]}:{rowCount:0,rows:[]};
      }
      if(sql.includes("INSERT INTO hrd_private.employee_profiles")){
        state.profile=JSON.parse(String(v[2]));
        return {rowCount:1,rows:[]};
      }
      if(sql.includes("SET status='verified'")){
        const d=state.docs.get(String(v[2]));
        if(!d||d.status!=="pending_review"||d.companyId!==v[3]||d.employeeId!==v[4])
          return {rowCount:0,rows:[]};
        d.status="verified";d.verified=JSON.parse(String(v[0]));
        return {rowCount:1,rows:[{id:d.id}]};
      }
      if(sql.includes("SELECT storage_path")){
        const d=state.docs.get(String(v[0]));
        return d&&d.companyId===v[1]&&d.employeeId===v[2]&&
          (d.status==="pending_review"||d.status==="verified")
          ?{rowCount:1,rows:[{storage_path:d.path}]}:{rowCount:0,rows:[]};
      }
      throw Error("Unexpected SQL in HRD synthetic test");
    }});
  },
}));
vi.mock("./hrd-document-ocr",()=>({
  hrdOcrReady:()=>true,
  validDocType:(v:unknown)=>["ktp","kk","sim","npwp","ijazah","skck","kontrak","foto"].includes(String(v)),
  validMime:(v:unknown)=>["image/jpeg","image/png","image/webp","application/pdf"].includes(String(v)),
  createPrivateUpload:async() =>({bucket:"bizportal-hrd-documents-prod",storageUrl:"https://nzdweipzckfszczzqtuw.supabase.co",token:"signed-test-token"}),
  readPrivateObject:async()=>Buffer.from(state.validBytes?[255,216,255,1,2,3]:[37,80,68,70,45]),
  documentMimeMatches:(bytes:Buffer,mime:string)=>mime==="image/jpeg"&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255,
  scanEmployeeDocument:async()=>({fields:{nik:"3174010101900001",nama_lengkap:"SYNTHETIC PERSON",alamat:"Synthetic address"},
    confidence:0.76,warnings:[],engine:"local"}),
  allowedDocumentFields:{
    ktp:["nik","nama_lengkap","alamat"],kk:["nomor_kk","nik","nama_lengkap","alamat","anggota_keluarga"],
    sim:["nomor_dokumen","nama_lengkap"],npwp:["nomor_dokumen","nama_lengkap","nik"],
    ijazah:["nama_lengkap"],skck:["nama_lengkap"],kontrak:["nama_lengkap"],foto:[],
  },
  validateReviewFields:(fields:unknown)=>{
    if(!fields||typeof fields!=="object"||Array.isArray(fields))throw Error("INVALID");
    const obj=fields as Record<string,unknown>;
    if(Object.keys(obj).some(k=>!["nik","nama_lengkap","alamat","jabatan"].includes(k)))throw Error("INVALID_FIELDS");
    if(Object.values(obj).some(v=>v!==null&&typeof v!=="string"))throw Error("INVALID_VALUE");
    return Object.fromEntries(Object.entries(obj).map(([k,v])=>[k,v]));
  },
  fieldsAllowedForDocument:(type:string,fields:Record<string,string|null>)=>{
    const allowed:Record<string,string[]>={ktp:["nik","nama_lengkap","alamat"]};
    if(Object.keys(fields).some(k=>!(allowed[type]??[]).includes(k)))throw Error("FIELD_NOT_ALLOWED");
    return fields;
  },
  documentHash:()=> "a".repeat(64),
  signedPrivatePreview:async(path:string)=>({
    url:"https://nzdweipzckfszczzqtuw.supabase.co/storage/v1/object/sign/bizportal-hrd-documents-prod/"+
      path+"?token=synthetic-preview",expiresIn:60,
  }),
}));
import { registerHrdOcrRoutes } from "./hrd-ocr-routes";

describe("HRD OCR synthetic HTTP lifecycle (no production writes)",()=>{
  let server:Server;
  let base:string;
  const post=async(suffix:string,body:unknown={})=>{
    const response=await fetch(base+"/api/hrd/employees/7/documents/"+suffix,{
      method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body),
    });
    return {status:response.status,body:await response.json() as Record<string,unknown>};
  };
  beforeAll(async()=>{
    const router=express.Router();
    router.use((request,_response,next)=>{
      Object.assign(request,{hrdCompanyId:state.tenant,hrdActor:{email:state.actor}});
      next();
    });
    registerHrdOcrRoutes(router);
    const app=express();app.use(express.json());app.use("/api",router);
    server=createServer(app);
    server.listen(0,"127.0.0.1");
    await once(server,"listening");
    const address=server.address();if(!address||typeof address==="string")throw Error("Test socket missing");
    base="http://127.0.0.1:"+address.port;
  });
  afterAll(async()=>{if(server)await new Promise<void>((resolve,reject)=>
    server.close(err=>err?reject(err):resolve()));});
  beforeEach(()=>{state.tenant=1;state.docs.clear();state.audit.length=0;
    state.profile=null;state.duplicatedNik=false;state.validBytes=true;});
  async function preparedKtp(){
    const p=await post("prepare",{docType:"ktp",mimeType:"image/jpeg",processingAuthorizationConfirmed:true});
    expect(p.status).toBe(201);
    return String(p.body.documentId);
  }
  it("prepare, local scan, HRD correction, verify and private preview; no replay",async()=>{
    const id=await preparedKtp();
    const scanned=await post(id+"/scan",{processingAuthorizationConfirmed:true});
    expect(scanned.status).toBe(200);
    expect(scanned.body).toMatchObject({status:"pending_review",engine:"local",masterChanged:false});
    expect((await post(id+"/scan",{processingAuthorizationConfirmed:true})).status).toBe(409);
    const result=await post(id+"/verify",{
      confirm:true,fields:{nik:"3174010101900001",nama_lengkap:"CORRECTED PERSON",alamat:"Corrected"},
    });
    expect(result.status).toBe(200);
    expect(result.body.status).toBe("verified");
    expect(state.profile?.nama_lengkap).toBe("CORRECTED PERSON");
    expect((await post(id+"/verify",{confirm:true,fields:{nama_lengkap:"REPLAY"}})).status).toBe(409);
    const preview=await post(id+"/preview");
    expect(preview.status).toBe(200);
    expect(preview.body.expiresIn).toBe(60);
    expect(state.audit).toHaveLength(3);
  });
  it("denies fresh scanning replay but recovers a stale scan without reuploading",async()=>{
    const id=await preparedKtp();
    const doc=state.docs.get(id)!;
    doc.status="scanning";doc.stale=false;
    expect((await post(id+"/scan",{processingAuthorizationConfirmed:true})).status).toBe(409);
    doc.stale=true;
    const result=await post(id+"/scan",{processingAuthorizationConfirmed:true});
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({status:"pending_review",masterChanged:false});
    expect(state.docs.get(id)?.status).toBe("pending_review");
    expect(state.profile).toBeNull();
    expect((await post(id+"/scan",{processingAuthorizationConfirmed:true})).status).toBe(409);
  });
  it("rejects KTP payroll/job field injection before changing shared profile",async()=>{
    const id=await preparedKtp();
    expect((await post(id+"/scan",{processingAuthorizationConfirmed:true})).status).toBe(200);
    const denied=await post(id+"/verify",{confirm:true,fields:{jabatan:"DIRECTOR"}});
    expect(denied.status).toBe(400);
    expect(state.profile).toBeNull();
    expect(state.docs.get(id)?.status).toBe("pending_review");
  });
  it("rejects duplicate NIK without overwriting identity",async()=>{
    const id=await preparedKtp();
    expect((await post(id+"/scan",{processingAuthorizationConfirmed:true})).status).toBe(200);
    state.duplicatedNik=true;
    const rejected=await post(id+"/verify",{confirm:true,fields:{nik:"3174010101900001"}});
    expect(rejected.status).toBe(409);
    expect(state.profile).toBeNull();
  });
  it("records scan_failed and leaves profile unchanged when MIME magic mismatches",async()=>{
    const id=await preparedKtp();
    state.validBytes=false;
    const failed=await post(id+"/scan",{processingAuthorizationConfirmed:true});
    expect(failed.status).toBe(503);
    expect(failed.body.code).toBe("HRD_OCR_MIME_MISMATCH");
    expect(failed.body).not.toHaveProperty("storage_path");
    expect(state.docs.get(id)?.status).toBe("scan_failed");
    expect(state.profile).toBeNull();
  });
  it("refuses photo OCR and missing explicit processing consent",async()=>{
    expect((await post("prepare",{docType:"foto",mimeType:"image/jpeg",processingAuthorizationConfirmed:true})).status).toBe(400);
    expect((await post("prepare",{docType:"ktp",mimeType:"image/jpeg"})).status).toBe(400);
    expect(state.docs.size).toBe(0);
  });
});
