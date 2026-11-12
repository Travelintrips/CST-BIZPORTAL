import { useEffect, useRef, useState } from "react";
import { Link, useRoute } from "wouter";
import { AppShell } from "@/components/layout/AppShell";
import { useCompany } from "@/contexts/CompanyContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Camera, FileText, Image as ImageIcon, LockKeyhole, ArrowLeft, RefreshCw } from "lucide-react";
import { HrdDocumentManager } from "./hrd-document-manager";
import { uploadHrdSignedDocument, type HrdSignedUpload } from "./hrd-signed-upload";

type Document = {
  id: string; doc_type: string; status: string; mime_type?: string;
  extracted_data?: Record<string, string | null>; created_at: string;
  verified_at: string | null; verified_data: Record<string, string | null> | null;
};
type Detail = {
  companyId: number; employeeId: number;
  employee: { id: number; company_id: number; first_name: string; last_name: string;
    position: string | null; status: string | null; email: string | null };
  verifiedProfile: Record<string, string | null>;
  documents: Document[];
  photoUploadEnabled: boolean;
  ocrEnabled: boolean;
  audit: Array<{ action: string; created_at: string; actor: string }>;
};
const MAX_BYTES = 5 * 1024 * 1024;
const IMG_TYPES = ["image/jpeg", "image/png", "image/webp"];
const DOCUMENT_NAMES: Record<string, string> = {
  ktp: "KTP", kk: "Kartu Keluarga", sim: "SIM", npwp: "NPWP",
  ijazah: "Ijazah", skck: "SKCK", kontrak: "Kontrak Kerja", foto: "Pas Foto",
};
export default function HrdEmployeeDetailPage() {
  const [, params] = useRoute("/hr/employees/:id");
  const employeeId = Number(params?.id);
  const { activeCompanyId, isConsolidated } = useCompany();
  const companyId = !isConsolidated && Number.isSafeInteger(Number(activeCompanyId)) && Number(activeCompanyId) > 0
    ? Number(activeCompanyId) : null;
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [photo, setPhoto] = useState<File | null>(null);
  const [photoUrl, setPhotoUrl] = useState("");
  const [photoError, setPhotoError] = useState("");
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoNotice, setPhotoNotice] = useState("");
  const [privatePreview, setPrivatePreview] = useState<{id:string;url:string}|null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const sequence = useRef(0);
  const photoEpoch = useRef(0);
  const scopedDetail = detail?.companyId === companyId && detail?.employeeId === employeeId
    && detail?.employee?.company_id === companyId ? detail : null;
  const refresh = async () => {
    const seq = ++sequence.current;
    // Preserve the mounted OCR reviewer while refreshing the SAME employee.
    // The render scope below masks any previous employee/company data.
    setError("");
    if (!companyId || !Number.isSafeInteger(employeeId) || employeeId <= 0) {
      setError("Pilih satu perusahaan dan karyawan yang valid."); return;
    }
    setLoading(true);
    try {
      const response = await fetch(`/api/hrd/employees/${employeeId}?companyId=${companyId}`, {
        credentials: "include", cache: "no-store",
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw Error(data.message || `HTTP ${response.status}`);
      if (data.companyId !== companyId || data.employeeId !== employeeId ||
          data.employee?.company_id !== companyId || data.employee?.id !== employeeId) {
        throw Error("Data HRD tidak sesuai perusahaan/karyawan yang dipilih.");
      }
      if (sequence.current === seq) setDetail(data as Detail);
    } catch (cause) {
      if (sequence.current === seq) {
        setDetail(null);
        setError(cause instanceof Error ? cause.message : "Detail HRD tidak tersedia.");
      }
    } finally {
      if (sequence.current === seq) setLoading(false);
    }
  };
  useEffect(() => {
    setDetail(null);
    setPrivatePreview(null);
    photoEpoch.current++;
    setPhotoBusy(false);
    void refresh();
    return () => { sequence.current++; photoEpoch.current++; };
  }, [companyId, employeeId]);
  useEffect(() => {
    if (!photo || !IMG_TYPES.includes(photo.type) || photo.size > MAX_BYTES) {
      setPhotoUrl(""); return;
    }
    const url = URL.createObjectURL(photo);
    setPhotoUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [photo]);
  useEffect(() => {
    setPhoto(null); setPhotoUrl(""); setPhotoError(""); setPhotoNotice(""); setPrivatePreview(null);
    if (fileInput.current) fileInput.current.value = "";
  }, [companyId, employeeId]);
  const choosePhoto = (file: File | undefined) => {
    if (!file) return;
    if (!IMG_TYPES.includes(file.type)) {
      setPhotoError("Pas Foto hanya menerima JPG, PNG, atau WEBP.");
      setPhoto(null); return;
    }
    if (file.size === 0 || file.size > MAX_BYTES) {
      setPhotoError("Ukuran Pas Foto harus lebih dari 0 dan maksimal 5 MB.");
      setPhoto(null); return;
    }
    setPhotoError(""); setPhoto(file);
  };
  const postPhoto = async <T,>(suffix: string, body: unknown): Promise<T> => {
    if (!companyId || !Number.isSafeInteger(employeeId) || employeeId <= 0) throw Error("Scope karyawan tidak valid.");
    const resp = await fetch(`/api/hrd/employees/${employeeId}/photo/${suffix}?companyId=${companyId}`, {
      method: "POST", credentials: "include", cache: "no-store",
      headers: {"content-type":"application/json"}, body:JSON.stringify(body),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw Error(data.message || `HTTP ${resp.status}`);
    return data as T;
  };
  const savePhoto = async () => {
    if (!photo || !scopedDetail?.photoUploadEnabled || !companyId || photoBusy) return;
    const epoch = photoEpoch.current;
    setPhotoBusy(true); setPhotoError(""); setPhotoNotice("");
    try {
      const prepared = await postPhoto<HrdSignedUpload>("prepare", {
        mimeType:photo.type,processingAuthorizationConfirmed:true,
      });
      if (epoch !== photoEpoch.current) return;
      await uploadHrdSignedDocument(prepared,photo,companyId,employeeId);
      if (epoch !== photoEpoch.current) return;
      const done = await postPhoto<{status:string}>(`${prepared.documentId}/complete`,{});
      if (done.status !== "pending_review") throw Error("Status upload belum dapat diverifikasi.");
      if (epoch !== photoEpoch.current) return;
      setPhotoNotice("Pas Foto tersimpan secara privat dan menunggu verifikasi HRD.");
      setPhoto(null); if (fileInput.current) fileInput.current.value = "";
      await refresh();
    } catch (cause) {
      if (epoch === photoEpoch.current) setPhotoError(cause instanceof Error ? cause.message : "Upload Pas Foto gagal.");
    } finally { if (epoch === photoEpoch.current) setPhotoBusy(false); }
  };
  const approvePhoto = async (documentId: string) => {
    if (!scopedDetail?.photoUploadEnabled || photoBusy || !window.confirm("Setujui Pas Foto karyawan ini?")) return;
    const epoch = photoEpoch.current;
    setPhotoBusy(true); setPhotoError("");
    try {
      const done = await postPhoto<{status:string}>(`${documentId}/verify`,{confirm:true});
      if (done.status !== "verified") throw Error("Verifikasi belum berhasil.");
      if (epoch !== photoEpoch.current) return;
      setPhotoNotice("Pas Foto berhasil diverifikasi HRD.");
      await refresh();
    } catch (cause) {
      if (epoch === photoEpoch.current) setPhotoError(cause instanceof Error ? cause.message : "Verifikasi Pas Foto gagal.");
    } finally { if (epoch === photoEpoch.current) setPhotoBusy(false); }
  };
  const showPrivatePhoto = async (documentId: string) => {
    if (!scopedDetail?.photoUploadEnabled || photoBusy) return;
    const epoch = photoEpoch.current;
    setPhotoBusy(true); setPhotoError("");
    try {
      const result = await postPhoto<{url:string;expiresIn:number}>(`${documentId}/preview`,{});
      if (!result.url.startsWith("https://nzdweipzckfszczzqtuw.supabase.co/storage/v1/object/sign/")) {
        throw Error("Alamat pratinjau privat tidak valid.");
      }
      if (epoch === photoEpoch.current) setPrivatePreview({id:documentId,url:result.url});
    } catch (cause) {
      if (epoch === photoEpoch.current) setPhotoError(cause instanceof Error ? cause.message : "Pratinjau Pas Foto gagal.");
    } finally { if (epoch === photoEpoch.current) setPhotoBusy(false); }
  };
  return <AppShell>
    <div className="mx-auto max-w-5xl space-y-5 p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href="/hr/employees" className="mb-2 inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-4 w-4" /> Kembali ke Data Karyawan
          </Link>
          <h1 className="text-2xl font-bold">Detail HRD Karyawan</h1>
          <p className="text-sm text-muted-foreground">Perusahaan ID {companyId ?? "—"} · Karyawan ID {employeeId || "—"}</p>
        </div>
        <Button variant="outline" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw className="mr-2 h-4 w-4" /> Muat ulang
        </Button>
      </div>
      {error && <div role="alert" className="rounded-lg border border-destructive/30 p-4 text-sm text-destructive">{error}</div>}
      {loading && <p className="text-sm text-muted-foreground">Memuat rincian HRD...</p>}
      {scopedDetail && <div className="grid gap-4 md:grid-cols-2">
        <Card><CardHeader><CardTitle>Identitas Karyawan</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p className="text-lg font-semibold">{scopedDetail.employee.first_name} {scopedDetail.employee.last_name}</p>
            <p>Jabatan: {scopedDetail.employee.position || "Belum diisi"}</p>
            <p>Status: {scopedDetail.employee.status || "Belum diketahui"}</p>
            <p>Email: {scopedDetail.employee.email || "Belum diisi"}</p>
            <h3 className="pt-3 font-semibold">Hasil identitas terverifikasi</h3>
            {Object.keys(scopedDetail.verifiedProfile).length === 0
              ? <p className="text-muted-foreground">Belum ada identitas HRD terverifikasi.</p>
              : Object.entries(scopedDetail.verifiedProfile).map(([key, value]) => <p key={key}>
                  <span className="text-muted-foreground">{key.replaceAll("_", " ")}: </span>{value || "—"}
                </p>)}
          </CardContent>
        </Card>
        <Card><CardHeader><CardTitle className="flex items-center gap-2"><FileText className="h-4 w-4" /> Dokumen</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            {scopedDetail.documents.length === 0 && <p className="text-muted-foreground">Belum ada dokumen HRD yang disimpan.</p>}
            {scopedDetail.documents.map((doc) => <div key={doc.id} className="rounded-lg border p-3">
              <p className="font-medium">{DOCUMENT_NAMES[doc.doc_type] || doc.doc_type}</p>
              <p className="text-xs text-muted-foreground">Status: {doc.status} · {new Date(doc.created_at).toLocaleDateString("id-ID")}</p>
              {doc.doc_type === "foto" && scopedDetail.photoUploadEnabled && (doc.status === "pending_review" || doc.status === "verified") && <div className="mt-2 flex flex-wrap gap-2">
                <Button size="sm" variant="outline" disabled={photoBusy} onClick={() => void showPrivatePhoto(doc.id)}>Lihat Pas Foto</Button>
                {doc.status === "pending_review" && <Button size="sm" disabled={photoBusy} onClick={() => void approvePhoto(doc.id)}>Setujui Pas Foto</Button>}
              </div>}
              {doc.doc_type !== "foto" && <p className="text-xs text-muted-foreground">Preview dokumen belum tersedia sampai layanan OCR diaktifkan.</p>}
              {privatePreview?.id === doc.id && <img src={privatePreview.url} alt="Pratinjau privat Pas Foto" className="mt-3 max-h-72 rounded-lg border object-contain" />}
            </div>)}
            <div className="rounded-lg border border-dashed p-3 text-muted-foreground">
              <LockKeyhole className="mb-2 h-5 w-5" />
              {scopedDetail.photoUploadEnabled ? "Upload Pas Foto privat aktif sesuai konfigurasi server. OCR dokumen lain belum diaktifkan." : "Upload, scan OCR, persetujuan, dan pratinjau dokumen nonaktif sampai storage privat dan uji akses selesai."}
            </div>
          </CardContent>
        </Card>
        <Card><CardHeader><CardTitle className="flex items-center gap-2"><Camera className="h-4 w-4" /> Pas Foto dari HP</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p className="text-muted-foreground">Di HP, pilih kamera depan jika browser mendukung. Kamera tidak aktif otomatis. Foto tidak dikirim ke server.</p>
            <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp" capture="user"
              className="block w-full text-sm" aria-label="Ambil Pas Foto atau pilih dari galeri"
              onChange={(e) => choosePhoto(e.target.files?.[0])} />
            {photoError && <p role="alert" className="text-destructive">{photoError}</p>}
            {photo && photoUrl && <div className="space-y-2">
              <img src={photoUrl} alt="Pratinjau Pas Foto lokal" className="h-48 w-40 rounded-lg border object-cover" />
              <p className="text-xs text-muted-foreground"><ImageIcon className="mr-1 inline h-3 w-3" />{photo.name} — hanya pratinjau pada perangkat</p>
              <Button variant="outline" size="sm" onClick={() => {
                setPhoto(null); if (fileInput.current) fileInput.current.value = "";
              }}>Hapus pratinjau</Button>
            </div>}
            {photoNotice && <p role="status" className="text-sm text-green-700 dark:text-green-300">{photoNotice}</p>}
            <Button className="w-full" disabled={!scopedDetail.photoUploadEnabled || !photo || photoBusy} onClick={() => void savePhoto()}>
              {photoBusy ? "Memproses Pas Foto..." : scopedDetail.photoUploadEnabled ? "Unggah Pas Foto Privat" : "Simpan Pas Foto (belum diaktifkan)"}
            </Button>
          </CardContent>
        </Card>
        <Card><CardHeader><CardTitle>Riwayat Verifikasi</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            {scopedDetail.audit.length === 0 && <p className="text-muted-foreground">Belum ada riwayat dokumen HRD.</p>}
            {scopedDetail.audit.map((entry, index) => <p key={index} className="border-b py-2">
              {entry.action} — {new Date(entry.created_at).toLocaleString("id-ID")}
            </p>)}
          </CardContent>
        </Card>
      </div>}
      {scopedDetail && companyId !== null && <HrdDocumentManager key={`${companyId}:${employeeId}`} companyId={companyId} employeeId={employeeId}
        enabled={scopedDetail.ocrEnabled === true} documents={scopedDetail.documents} refresh={refresh} />}
    </div>
  </AppShell>;
}
