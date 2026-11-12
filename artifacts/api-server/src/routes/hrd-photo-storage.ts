import { createHash } from "node:crypto";

const BUCKET = "bizportal-hrd-documents-prod";
const PROD_REF = "nzdweipzckfszczzqtuw";
const MAX_BYTES = 5 * 1024 * 1024;
type PhotoMime = "image/jpeg" | "image/png" | "image/webp";

export function validPhotoMime(value: unknown): value is PhotoMime {
  return value === "image/jpeg" || value === "image/png" || value === "image/webp";
}
export function validPhotoBytes(bytes: Buffer, mime: PhotoMime): boolean {
  if (!bytes.length || bytes.length > MAX_BYTES) return false;
  if (mime === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mime === "image/png") return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  return bytes.length >= 12 && bytes.toString("ascii",0,4) === "RIFF" && bytes.toString("ascii",8,12) === "WEBP";
}
export function hrdPrivateStorageReady(): boolean {
  return process.env.APP_ENV === "production" &&
    process.env.HRD_PROD_DOCUMENTS_ENABLED === "true" &&
    process.env.HRD_PROD_SUPABASE_URL?.replace(/\/$/, "") === `https://${PROD_REF}.supabase.co` &&
    Boolean(process.env.HRD_PROD_STORAGE_SERVICE_KEY?.trim());
}
/**
 * Read-only credential/bucket preflight independent of feature activation.
 * Never returns the key, upstream response body, raw URL or backend internals.
 */
export async function probeHrdPrivateStorage(): Promise<boolean> {
  const base=process.env.HRD_PROD_SUPABASE_URL?.trim().replace(/\/$/,"");
  const key=process.env.HRD_PROD_STORAGE_SERVICE_KEY?.trim();
  if(process.env.APP_ENV!=="production" ||
     base!==`https://${PROD_REF}.supabase.co` || !key) return false;
  try {
    const response=await fetch(`${base}/storage/v1/bucket/${BUCKET}`,{
      method:"GET",
      headers:{apikey:key,Authorization:`Bearer ${key}`},
      signal:AbortSignal.timeout(10000),
    });
    if(!response.ok)return false;
    const metadata=await response.json() as {
      id?:unknown;public?:unknown;file_size_limit?:unknown;
    };
    return metadata.id===BUCKET && metadata.public===false &&
      typeof metadata.file_size_limit==="number" &&
      metadata.file_size_limit<=MAX_BYTES;
  }catch{return false;}
}

function storageConfig() {
  if (!hrdPrivateStorageReady()) throw Error("HRD_PRIVATE_STORAGE_DISABLED");
  return {
    base: `https://${PROD_REF}.supabase.co`,
    key: process.env.HRD_PROD_STORAGE_SERVICE_KEY!.trim(),
  };
}
function pathSafe(path: string): boolean {
  return /^[1-9][0-9]*\/[1-9][0-9]*\/[0-9a-f-]{36}\.(?:jpg|png|webp)$/.test(path) &&
    !path.includes("..");
}
function headers(key: string): Record<string,string> {
  return { apikey: key, Authorization: `Bearer ${key}` };
}
export async function createHrdPhotoSignedUpload(path: string) {
  if (!pathSafe(path)) throw Error("HRD_STORAGE_INVALID_PATH");
  const {base,key} = storageConfig();
  const response = await fetch(`${base}/storage/v1/object/upload/sign/${BUCKET}/${path}`, {
    method: "POST", headers: {...headers(key),"content-type":"application/json"},
    body: JSON.stringify({upsert:false}), signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw Error("HRD_STORAGE_SIGN_UPLOAD_FAILED");
  const body = await response.json() as {token?:string;url?:string};
  const token = body.token ?? (body.url ? new URL(body.url,base).searchParams.get("token") : null);
  if (!token) throw Error("HRD_STORAGE_SIGN_UPLOAD_EMPTY");
  return {storageUrl:base, bucket:BUCKET, path, token};
}
export async function readHrdPhoto(path: string): Promise<Buffer> {
  if (!pathSafe(path)) throw Error("HRD_STORAGE_INVALID_PATH");
  const {base,key} = storageConfig();
  const response = await fetch(`${base}/storage/v1/object/authenticated/${BUCKET}/${path}`,{
    headers:headers(key),signal:AbortSignal.timeout(30000),
  });
  if (!response.ok) throw Error("HRD_STORAGE_OBJECT_MISSING");
  const headerSize = Number(response.headers.get("content-length") ?? "0");
  if (headerSize > MAX_BYTES) throw Error("HRD_STORAGE_OBJECT_TOO_LARGE");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_BYTES) throw Error("HRD_STORAGE_OBJECT_INVALID_SIZE");
  return bytes;
}
export async function signHrdPhotoPreview(path: string) {
  if (!pathSafe(path)) throw Error("HRD_STORAGE_INVALID_PATH");
  const {base,key} = storageConfig();
  const response = await fetch(`${base}/storage/v1/object/sign/${BUCKET}/${path}`, {
    method:"POST",headers:{...headers(key),"content-type":"application/json"},
    body:JSON.stringify({expiresIn:60}),signal:AbortSignal.timeout(15000),
  });
  if (!response.ok) throw Error("HRD_STORAGE_PREVIEW_FAILED");
  const body = await response.json() as {signedURL?:string;signedUrl?:string};
  const signed = body.signedURL ?? body.signedUrl;
  return {url:validateHrdPhotoSignedPreview(base,path,signed),expiresIn:60};
}
export function photoSha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Supabase may return a /object/sign/... URL. Never trust an unsigned,
 * different-bucket, changed-object or different-origin preview response.
 */
export function validateHrdPhotoSignedPreview(base:string,path:string,signed:unknown):string {
  if (!pathSafe(path) || typeof signed!=="string" || !signed) throw Error("HRD_STORAGE_PREVIEW_INVALID");
  const origin=new URL(base).origin;
  const relative=signed.startsWith("/object/sign/")?"/storage/v1"+signed:signed;
  const parsed=new URL(relative,origin);
  const expected="/storage/v1/object/sign/"+BUCKET+"/"+path;
  if(parsed.origin!==origin||parsed.pathname!==expected||
     !parsed.searchParams.get("token")||parsed.username||parsed.password)
    throw Error("HRD_STORAGE_PREVIEW_INVALID");
  return parsed.toString();
}
