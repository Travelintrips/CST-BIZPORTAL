import { createHash, randomUUID } from "node:crypto";

// One-time synthetic storage test only. No employee ID or HRD database mutation.
// The canary has a separate, default-OFF switch and never enables document/OCR routes.
const REF = "nzdweipzckfszczzqtuw";
const BUCKET = "bizportal-hrd-documents-prod";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlB6X8AAAAASUVORK5CYII=",
  "base64",
);

type Result = { ok: boolean; uploaded: boolean; readback: boolean; preview: boolean; cleaned: boolean };
const notReady = (): Result => ({ ok:false,uploaded:false,readback:false,preview:false,cleaned:false });

export async function runHrdStorageCanary(): Promise<Result> {
  const base = process.env.HRD_PROD_SUPABASE_URL?.trim().replace(/\/$/, "");
  const key = process.env.HRD_PROD_STORAGE_SERVICE_KEY?.trim();
  if (process.env.APP_ENV !== "production" ||
      process.env.HRD_PROD_STORAGE_CANARY_ENABLED !== "true" ||
      process.env.HRD_PROD_DOCUMENTS_ENABLED === "true" ||
      process.env.HRD_PROD_OCR_ENABLED === "true" ||
      base !== "https://" + REF + ".supabase.co" || !key) return notReady();

  const path = "_synthetic_canary/" + randomUUID() + ".png";
  const objectUrl = base + "/storage/v1/object/" + BUCKET + "/" + path;
  const uploadSignUrl = base + "/storage/v1/object/upload/sign/" + BUCKET + "/" + path;
  const headers = { apikey:key, Authorization:"Bearer " + key };
  const checksum = createHash("sha256").update(PNG).digest("hex");
  let created = false, uploaded = false, readback = false, preview = false, cleaned = false;
  const timeout = () => AbortSignal.timeout(15000);
  try {
    const prepared = await fetch(uploadSignUrl, {
      method:"POST", headers:{...headers,"content-type":"application/json"},
      body:JSON.stringify({upsert:false}), signal:timeout(),
    });
    if (!prepared.ok) return notReady();
    const signed = await prepared.json() as { token?:string;url?:string };
    const token = signed.token ?? (signed.url ? new URL(signed.url,base).searchParams.get("token") : null);
    if (!token) return notReady();
    // A timed-out PUT may have succeeded. Always attempt cleanup after issuing it.
    created = true;
    const put = await fetch(uploadSignUrl + "?token=" + encodeURIComponent(token), {
      method:"PUT",headers:{"content-type":"image/png","x-upsert":"false"},
      body:PNG,signal:timeout(),
    });
    if (!put.ok) return notReady();
    uploaded = true;

    const read = await fetch(base + "/storage/v1/object/authenticated/" + BUCKET + "/" + path,{
      headers,signal:timeout(),
    });
    if (read.ok) {
      const bytes=Buffer.from(await read.arrayBuffer());
      readback=bytes.length===PNG.length &&
        createHash("sha256").update(bytes).digest("hex")===checksum;
    }
    if (readback) {
      const sign=await fetch(base + "/storage/v1/object/sign/" + BUCKET + "/" + path,{
        method:"POST",headers:{...headers,"content-type":"application/json"},
        body:JSON.stringify({expiresIn:60}),signal:timeout(),
      });
      if (sign.ok) {
        const body=await sign.json() as {signedURL?:string;signedUrl?:string};
        const raw=body.signedURL ?? body.signedUrl;
        if (raw) {
          const relative=raw.startsWith("/object/sign/") ? "/storage/v1"+raw:raw;
          const url=new URL(relative,base);
          const expected="/storage/v1/object/sign/"+BUCKET+"/"+path;
          if (url.origin===base && url.pathname===expected && url.searchParams.has("token")) {
            const signedRead=await fetch(url,{signal:timeout()});
            if(signedRead.ok) {
              const bytes=Buffer.from(await signedRead.arrayBuffer());
              preview=bytes.length===PNG.length &&
                createHash("sha256").update(bytes).digest("hex")===checksum;
            }
          }
        }
      }
    }
  } catch {
    // Keep all errors and credentials server side; expose only phase booleans.
  } finally {
    if (created) {
      try {
        const removed=await fetch(objectUrl,{method:"DELETE",headers,signal:timeout()});
        cleaned=removed.ok;
      } catch { cleaned=false; }
    }
  }
  return {ok:uploaded && readback && preview && cleaned,uploaded,readback,preview,cleaned};
}
