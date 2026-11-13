/**
 * Browser-side HRD private upload. Matches Supabase Storage uploadToSignedUrl:
 * PUT /storage/v1/object/upload/sign/{bucket}/{path}?token=...
 * with a multipart FormData body (including an empty-name file field).
 *
 * The backend signs one fresh object path. Never use this helper for public
 * buckets, direct service-role uploads, or URLs supplied by the user.
 */
const PROD_ORIGIN = "https://nzdweipzckfszczzqtuw.supabase.co";
const HRD_BUCKET = "bizportal-hrd-documents-prod";
const MAX_BYTES = 5 * 1024 * 1024;

const extensions: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

export interface HrdSignedUpload {
  companyId: number;
  employeeId: number;
  documentId: string;
  storageUrl: string;
  bucket: string;
  path: string;
  token: string;
  maxBytes: number;
}

export function buildHrdSignedUploadUrl(
  signed: HrdSignedUpload,
  file: File,
  expectedCompanyId: number,
  expectedEmployeeId: number,
): string {
  if (
    !Number.isSafeInteger(expectedCompanyId) || expectedCompanyId <= 0 ||
    !Number.isSafeInteger(expectedEmployeeId) || expectedEmployeeId <= 0 ||
    signed.companyId !== expectedCompanyId ||
    signed.employeeId !== expectedEmployeeId ||
    signed.storageUrl !== PROD_ORIGIN ||
    signed.bucket !== HRD_BUCKET ||
    !Number.isInteger(signed.maxBytes) ||
    signed.maxBytes <= 0 || signed.maxBytes > MAX_BYTES ||
    !file || file.size <= 0 || file.size > signed.maxBytes
  ) {
    throw new Error("Tujuan, perusahaan, atau ukuran dokumen HRD tidak valid.");
  }

  const ext = extensions[file.type];
  if (!ext || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(signed.documentId)) {
    throw new Error("Format file atau ID dokumen HRD tidak valid.");
  }

  const expectedPath = `${expectedCompanyId}/${expectedEmployeeId}/${signed.documentId}.${ext}`;
  if (signed.path !== expectedPath || typeof signed.token !== "string" ||
      !signed.token || signed.token.length > 4096 || /[\u0000-\u001f\u007f]/.test(signed.token)) {
    throw new Error("Path atau token upload privat tidak sesuai.");
  }

  const url = new URL(`/storage/v1/object/upload/sign/${HRD_BUCKET}/${expectedPath}`, PROD_ORIGIN);
  url.searchParams.set("token", signed.token);
  return url.toString();
}

/**
 * Only the digest is used for the authenticated, employee-scoped duplicate
 * preflight. The upload still sends the exact original File unchanged.
 * Degrade to the existing upload behavior if WebCrypto is unavailable.
 */
export async function hashHrdOriginalFile(file: File): Promise<string | null> {
  if (!file || file.size <= 0 || file.size > MAX_BYTES) return null;
  try {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) return null;
    const digest = await subtle.digest("SHA-256", await file.arrayBuffer());
    return Array.from(new Uint8Array(digest), byte =>
      byte.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

export async function uploadHrdSignedDocument(
  signed: HrdSignedUpload,
  file: File,
  companyId: number,
  employeeId: number,
): Promise<void> {
  const url = buildHrdSignedUploadUrl(signed, file, companyId, employeeId);
  const body = new FormData();
  body.append("cacheControl", "3600");
  body.append("", file);
  const response = await fetch(url, {
    method: "PUT",
    headers: { "x-upsert": "false" },
    body,
  });
  if (!response.ok) {
    throw new Error("Upload privat gagal. Periksa jaringan atau coba gunakan file baru.");
  }
}
