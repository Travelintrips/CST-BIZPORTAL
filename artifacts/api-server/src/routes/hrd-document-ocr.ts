import {createHash} from "node:crypto";
import {extractLocalOcrText,parseLocalDocumentFields,localDocumentFieldsComplete,localDocumentFieldCoverage} from "./hrd-document-ocr-local";

export const HRD_BUCKET="bizportal-hrd-documents-dev";
export function hrdBucketName(){return process.env.APP_ENV==="production"?"bizportal-hrd-documents-prod":HRD_BUCKET;}
function hrdEnv(){return process.env.APP_ENV==="development"||process.env.APP_ENV==="production"?process.env.APP_ENV:null;}
function hrdStorageSettings(){const env=hrdEnv();if(env==="development")return {url:process.env.HRD_DEV_SUPABASE_URL?.trim()??"",key:process.env.HRD_DEV_STORAGE_SERVICE_KEY?.trim()??"",ref:"xssrfshdrtdfupgqwfdw"};if(env==="production")return {url:(process.env.HRD_PROD_SUPABASE_URL??process.env.SUPABASE_URL)?.trim()??"",key:(process.env.HRD_PROD_STORAGE_SERVICE_KEY??process.env.SUPABASE_SERVICE_ROLE_KEY)?.trim()??"",ref:"nzdweipzckfszczzqtuw"};return {url:"",key:"",ref:""};}
function hrdOpenAiKey(){return (hrdEnv()==="production"?(process.env.HRD_PROD_OPENAI_API_KEY??process.env.OPENAI_API_KEY):process.env.HRD_DEV_OPENAI_API_KEY)?.trim()??"";}
function hrdModel(){return (hrdEnv()==="production"?process.env.HRD_PROD_OCR_MODEL:process.env.HRD_DEV_OCR_MODEL)?.trim()||"gpt-4.1-mini";}
export const HRD_DOC_TYPES=["ktp","kk","foto","sim","npwp","ijazah","skck","kontrak"] as const;
export type HrdDocumentType=typeof HRD_DOC_TYPES[number];
export const MAX_DOCUMENT_BYTES=5*1024*1024;
const mimeTypes=new Set(["image/jpeg","image/png","image/webp","application/pdf"]);

export const extractionFields=[
 "nik","nama_lengkap","tempat_lahir","tanggal_lahir","alamat","nomor_kk",
 "nomor_dokumen","jenis_sim","masa_berlaku","institusi","jurusan",
 "tahun_lulus","jabatan","tanggal_mulai_kontrak","tanggal_akhir_kontrak",
 "jenis_kelamin","agama","status_perkawinan","rt_rw","kelurahan","kecamatan",
 "anggota_keluarga",
] as const;
export type HrdField=typeof extractionFields[number];
export const allowedDocumentFields:Record<HrdDocumentType,readonly HrdField[]>={
 ktp:["nik","nama_lengkap","tempat_lahir","tanggal_lahir","alamat",
  "jenis_kelamin","agama","status_perkawinan","rt_rw","kelurahan","kecamatan"],
 kk:["nomor_kk","nik","nama_lengkap","alamat","anggota_keluarga"],
 sim:["nomor_dokumen","nama_lengkap","jenis_sim","masa_berlaku"],
 npwp:["nomor_dokumen","nik","nama_lengkap","alamat"],
 ijazah:["nama_lengkap","institusi","jurusan","tahun_lulus","nomor_dokumen"],
 skck:["nama_lengkap","nomor_dokumen","masa_berlaku"],
 kontrak:["nama_lengkap","jabatan","tanggal_mulai_kontrak","tanggal_akhir_kontrak"],
 foto:[]
};
export function fieldsAllowedForDocument(docType:HrdDocumentType,fields:Record<string,string|null>){
 const permitted=allowedDocumentFields[docType];
 if(Object.keys(fields).some(k=>!permitted.includes(k as HrdField)))
  throw Error("FIELD_NOT_ALLOWED_FOR_DOCUMENT");
 return fields;
}

export type HrdExtracted=Record<HrdField,string|null>;
export function validDocType(x:unknown):x is HrdDocumentType{
 return typeof x==="string"&&(HRD_DOC_TYPES as readonly string[]).includes(x);
}
export function validMime(x:unknown):x is string{return typeof x==="string"&&mimeTypes.has(x)}
export function normalizeExtraction(data:unknown,confidence:unknown,warnings:unknown){
 const source=data&&typeof data==="object"&&!Array.isArray(data)?data as Record<string,unknown>:{};
 const out={} as HrdExtracted;
 for(const f of extractionFields){
  const raw=source[f];
  out[f]=typeof raw==="string"?raw.trim().slice(0,f==="anggota_keluarga"?4000:320)||null:null;
 }
 // OCR never invents missing values. NIK must be exactly 16 digits.
 if(out.nik&&!/^\d{16}$/.test(out.nik))out.nik=null;
 if(out.nomor_kk&&!/^\d{16}$/.test(out.nomor_kk))out.nomor_kk=null;
 for(const key of ["tanggal_lahir","masa_berlaku","tanggal_mulai_kontrak","tanggal_akhir_kontrak"] as const){
  if(out[key]&&!/^\d{4}-\d{2}-\d{2}$/.test(out[key]!))out[key]=null;
 }
 const value=typeof confidence==="number"&&Number.isFinite(confidence)?
  Math.max(0,Math.min(1,confidence)):0;
 const flags=Array.isArray(warnings)?warnings.filter(x=>typeof x==="string")
  .slice(0,12).map((x:string)=>x.slice(0,160)):[];
 return {fields:out,confidence:value,warnings:flags};
}
export function validateReviewFields(data:unknown){
 if(!data||typeof data!=="object"||Array.isArray(data))throw Error("INVALID_REVIEW_FIELDS");
 const raw=data as Record<string,unknown>;
 if(Object.keys(raw).some(key=>!(extractionFields as readonly string[]).includes(key)))
  throw Error("UNEXPECTED_REVIEW_FIELD");
 const out:Record<string,string|null>={};
 for(const [key,value] of Object.entries(raw)){
  if(value!==null&&typeof value!=="string")throw Error("INVALID_REVIEW_VALUE");
  const cleaned=typeof value==="string"?value.trim():null;
  if(cleaned && cleaned.length>(key==="anggota_keluarga"?4000:320))throw Error("REVIEW_VALUE_TOO_LONG");
  out[key]=cleaned||null;
 }
 if(out.nik&&!/^\d{16}$/.test(out.nik))throw Error("NIK_MUST_BE_16_DIGITS");
 if(out.nomor_kk&&!/^\d{16}$/.test(out.nomor_kk))throw Error("KK_MUST_BE_16_DIGITS");
 return out;
}

function localOcrEnabled(){
 const env=hrdEnv();
 return env==="production"?process.env.HRD_PROD_OCR_LOCAL_ENABLED!=="false":process.env.HRD_DEV_OCR_LOCAL_ENABLED!=="false";
}
function openAiFallbackEnabled(){
 const env=hrdEnv();
 const enabled=env==="production"?process.env.HRD_PROD_OCR_OPENAI_FALLBACK_ENABLED!=="false":process.env.HRD_DEV_OCR_OPENAI_FALLBACK_ENABLED!=="false";
 return enabled&&Boolean(hrdOpenAiKey());
}
export function hrdOcrReady(){
 const env=hrdEnv();if(!env)return false;
 if(env==="development"&&process.env.HRD_DEV_OCR_ENABLED!=="true")return false;
 if(env==="production"&&process.env.HRD_PROD_OCR_ENABLED!=="true")return false;
 const cfg=hrdStorageSettings();let parsed:URL;try{parsed=new URL(cfg.url);}catch{return false;}
 return parsed.protocol==="https:"&&parsed.hostname===cfg.ref+".supabase.co"&&Boolean(cfg.key)&&(localOcrEnabled()||openAiFallbackEnabled());
}
function storageConfig(){
 const cfg=hrdStorageSettings();let parsed:URL;try{parsed=new URL(cfg.url);}catch{throw Error("HRD_PRIVATE_STORAGE_NOT_CONFIGURED");}
 if(!hrdOcrReady()||parsed.protocol!=="https:"||parsed.hostname!==cfg.ref+".supabase.co"||!cfg.key)throw Error("HRD_PRIVATE_STORAGE_NOT_CONFIGURED");
 return {base:cfg.url.replace(/\/$/,""),key:cfg.key};
}
export async function createPrivateUpload(path:string){
 const {base,key}=storageConfig();
 const resp=await fetch(`${base}/storage/v1/object/upload/sign/${hrdBucketName()}/${path}`,{
  method:"POST",headers:{...storageHeaders(key),"content-type":"application/json"},
  body:JSON.stringify({upsert:false})
 });
 if(!resp.ok)throw Error("PRIVATE_UPLOAD_SIGNING_FAILED");
 const body=await resp.json() as {token?:string};
 if(!body.token)throw Error("PRIVATE_UPLOAD_TOKEN_MISSING");
 return {token:body.token,storageUrl:base,bucket:hrdBucketName()};
}
export async function readPrivateObject(path:string){
 const {base,key}=storageConfig();
 const response=await fetch(`${base}/storage/v1/object/authenticated/${hrdBucketName()}/${path}`,{
  headers:storageHeaders(key),signal:AbortSignal.timeout(30000)
 });
 if(!response.ok)throw Error("PRIVATE_DOCUMENT_NOT_UPLOADED");
 const bytes=Buffer.from(await response.arrayBuffer());
 if(bytes.length===0||bytes.length>MAX_DOCUMENT_BYTES)throw Error("INVALID_DOCUMENT_SIZE");
 return bytes;
}
export async function deletePrivateObject(path:string){
 const {base,key}=storageConfig();
 await fetch(`${base}/storage/v1/object/${hrdBucketName()}/${path}`,{
  method:"DELETE",headers:storageHeaders(key)
 }).catch(()=>{});
}
const fieldProperties=Object.fromEntries(extractionFields.map(field=>[field,{
 type:["string","null"]
}]));
const ocrSchema={
 type:"object",additionalProperties:false,
 properties:{
  fields:{type:"object",additionalProperties:false,
   properties:fieldProperties,required:[...extractionFields]},
  confidence:{type:"number",minimum:0,maximum:1},
  warnings:{type:"array",items:{type:"string"}}
 },
 required:["fields","confidence","warnings"]
};
function outputText(response:any):string{
 if(typeof response.output_text==="string")return response.output_text;
 return (Array.isArray(response.output)?response.output:[])
  .flatMap((x:any)=>Array.isArray(x.content)?x.content:[])
  .filter((x:any)=>x.type==="output_text")
  .map((x:any)=>String(x.text??"")).join("");
}
export async function scanEmployeeDocument(bytes:Buffer,mime:string,docType:HrdDocumentType,
 localReader:typeof extractLocalOcrText=extractLocalOcrText,providerFetch:typeof fetch=fetch){
 if(!hrdOcrReady())throw Error("HRD_OCR_NOT_CONFIGURED");
 if(!validMime(mime)||bytes.length===0||bytes.length>MAX_DOCUMENT_BYTES)
  throw Error("INVALID_OCR_ATTACHMENT");
 // Pas foto is stored privately but never sent to an OCR provider.
 if(docType==="foto"){
  return {fields:normalizeExtraction({},0,[]).fields,confidence:0,
   warnings:["Pas foto tidak memerlukan OCR."],engine:"not_required" as const};
 }
 const local=localOcrEnabled()?await localReader(bytes,mime):{
  text:"",confidence:0,source:"unavailable" as const,warnings:["OCR lokal dinonaktifkan."]
 };
 const localFields=parseLocalDocumentFields(docType,local.text);
 const coverage=localDocumentFieldCoverage(docType,localFields);
 const localConfidence=local.text.trim().length>=24?
  Math.max(0,Math.min(1,local.confidence*0.75+coverage*0.25)):0;
 const localResult=normalizeExtraction(localFields,localConfidence,local.warnings);
 const hasLocalFields=Object.values(localResult.fields).some(value=>Boolean(value?.trim()));
 // Validate required fields after normalization too (e.g. reject malformed NIK/KK IDs).
 const localComplete=local.text.trim().length>=24 &&
  localDocumentFieldsComplete(docType,localResult.fields) && localResult.confidence>=0.55;
 if(localComplete){
  return {...localResult,engine:"local" as const,
   warnings:[...localResult.warnings,"Sumber: OCR lokal; tidak menggunakan kuota OpenAI."]};
 }
 if(!openAiFallbackEnabled()){
  if(!hasLocalFields)throw Error("HRD_OCR_NO_LOCAL_FIELDS");
  return {...localResult,engine:"local_manual_review" as const,
   warnings:[...localResult.warnings,
    "AI cadangan tidak aktif. Periksa dan lengkapi field kosong secara manual."]};
 }
 const apiKey=hrdOpenAiKey();
 const instruction=[
  "Ekstraksi dokumen HRD Indonesia tipe "+docType.toUpperCase()+".",
  "Hanya ekstrak nilai yang terlihat jelas. Jangan menebak informasi hilang.",
  "Jangan menggunakan nama karyawan dari konteks lain.",
  "Format tanggal YYYY-MM-DD jika terbaca jelas; bila ragu gunakan null.",
  "Untuk KK, anggota_keluarga satu baris per orang: Nama | Hubungan Keluarga | Tanggal Lahir (YYYY-MM-DD).",
  "Jangan menambah anggota yang tidak tercantum. Untuk selain KK, anggota_keluarga harus null.",
  "NIK dan nomor KK yang tidak tepat 16 angka harus null. Jangan cantumkan data lain pada warnings.",
  "Tampilkan confidence realistis antara 0 dan 1."
 ].join("\n");
 const encoded=bytes.toString("base64");
 const attachment=mime==="application/pdf"
  ?{type:"input_file",filename:"document.pdf",file_data:"data:"+mime+";base64,"+encoded}
  :{type:"input_image",image_url:"data:"+mime+";base64,"+encoded,detail:"high"};
 const hasLocalText=local.text.trim().length>=24;
 const content:any=[{type:"input_text",text:instruction}];
 if(hasLocalText){
  // Supply the local transcript as context, but never use it as a substitute for the
  // original pixels/file when required fields are still missing.
  content.push({type:"input_text",text:"Hasil OCR lokal (dapat tidak lengkap). Gunakan sebagai petunjuk, periksa dokumen asli dan jangan menebak.\n"+local.text.slice(0,12000)});
 }
 // This path runs only after local extraction failed the required-field completeness gate.
 // Keep the original image/PDF so the vision fallback can recover text omitted by local OCR.
 content.push(attachment);
 try{
  const response=await providerFetch("https://api.openai.com/v1/responses",{
   method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+apiKey},
   signal:AbortSignal.timeout(60000),
   body:JSON.stringify({
    model:hrdModel(),
    store:false,input:[{role:"user",content}],
    text:{format:{type:"json_schema",name:"hrd_document_scan",strict:true,schema:ocrSchema}},
    max_output_tokens:1400
   })
  });
  if(!response.ok){
   const failure=await response.json().catch(()=>null) as any;
   const providerCode=typeof failure?.error?.code==="string"?failure.error.code:null;
   const providerType=typeof failure?.error?.type==="string"?failure.error.type:null;
   throw Error(ocrProviderFailureCode(response.status,providerCode,providerType));
  }
  const parsed=await response.json() as any;
  let json:unknown;
  try{json=JSON.parse(outputText(parsed))}catch{throw Error("HRD_OCR_INVALID_RESULT")}
  const record=json&&typeof json==="object"?json as Record<string,unknown>:{};
  const result=normalizeExtraction(record.fields,record.confidence,record.warnings);
  return {...result,engine:"openai_fallback" as const,
   warnings:[...local.warnings,...result.warnings,
    "Sumber: OpenAI sebagai cadangan karena hasil OCR lokal belum cukup lengkap."]};
 }catch(error){
  const raw=error instanceof Error?error.message:"";
  const safeCode=/^HRD_OCR_PROVIDER_HTTP_\d{3}(?:_[A-Z0-9_]+)?$/.test(raw)?raw:"HRD_OCR_FALLBACK_UNAVAILABLE";
  if(!hasLocalFields)throw Error(safeCode);
  return {...localResult,engine:"openai_fallback_failed" as const,
   warnings:[...localResult.warnings,
    "AI cadangan tidak tersedia ("+safeCode+"). Hasil lokal ditampilkan untuk pemeriksaan manual; tidak ada profil yang diubah."]};
 }
}
export function ocrProviderFailureCode(status:number,providerCode?:unknown,providerType?:unknown){
 if(!Number.isInteger(status)||status<400||status>599)return "HRD_OCR_PROVIDER_FAILED";
 const allowed=new Set([
  "insufficient_quota","rate_limit_exceeded","billing_hard_limit_reached",
  "credit_balance_exhausted","organization_usage_limit_exceeded",
  "organization_spend_limit_exceeded","project_spend_limit_exceeded",
  "requests","tokens","invalid_api_key","model_not_found","account_deactivated"
 ]);
 // OpenAI's error.code is more specific than error.type. Prefer it, and
 // use the broader type only when the code is missing or not recognized.
 const code=typeof providerCode==="string"?providerCode.trim().toLowerCase():"";
 const type=typeof providerType==="string"?providerType.trim().toLowerCase():"";
 const reason=allowed.has(code)?code:allowed.has(type)?type:"";
 const suffix=reason?"_"+reason.toUpperCase():"";
 return "HRD_OCR_PROVIDER_HTTP_"+status+suffix;
}
export function documentHash(bytes:Buffer){return createHash("sha256").update(bytes).digest("hex")}

export async function signedPrivatePreview(path:string){
 const {base,key}=storageConfig();
 const response=await fetch(`${base}/storage/v1/object/sign/${hrdBucketName()}/${path}`,{
  method:"POST",headers:{...storageHeaders(key),"content-type":"application/json"},
  body:JSON.stringify({expiresIn:60})
 });
 if(!response.ok)throw Error("HRD_DOCUMENT_PREVIEW_UNAVAILABLE");
 const json=await response.json() as {signedURL?:string;signedUrl?:string};
 const signed=json.signedURL??json.signedUrl;
 return {url:validateHrdSignedPreviewUrl(base,path,signed),expiresIn:60};
}
export function documentMimeMatches(bytes:Buffer,mime:string){
 if(mime==="application/pdf")return bytes.subarray(0,5).toString("ascii")==="%PDF-";
 if(mime==="image/jpeg")return bytes.length>3&&bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff;
 if(mime==="image/png")return bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
 if(mime==="image/webp")return bytes.subarray(0,4).toString("ascii")==="RIFF"&&
  bytes.subarray(8,12).toString("ascii")==="WEBP";
 return false;
}
/**
 * Supabase Storage may return /object/sign/... rather than /storage/v1/object/sign/...
 * Never follow a signed URL that changes origin, bucket, object or token scope.
 */
export function validateHrdSignedPreviewUrl(base:string,path:string,signed:unknown):string{
 if(typeof signed!=="string"||!signed)throw Error("HRD_SIGNED_URL_INVALID");
 const origin=new URL(base).origin;
 const relative=signed.startsWith("/object/sign/")?"/storage/v1"+signed:signed;
 const parsed=new URL(relative,origin);
 const expected="/storage/v1/object/sign/"+hrdBucketName()+"/"+path;
 if(parsed.origin!==origin||parsed.pathname!==expected||
    !parsed.searchParams.get("token")||parsed.username||parsed.password)
  throw Error("HRD_SIGNED_URL_INVALID");
 return parsed.toString();
}
