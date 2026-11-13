import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { FileText, Upload, ShieldCheck } from "lucide-react";
import { hashHrdOriginalFile, uploadHrdSignedDocument, type HrdSignedUpload } from "./hrd-signed-upload";

type DocumentType = "ktp"|"kk"|"sim"|"npwp"|"ijazah"|"skck"|"kontrak";
type Document = {
  id:string; doc_type:string; mime_type?:string; status:string; confidence?:number|string|null;
  extracted_data?:Record<string,string|null>;
  verified_data?:Record<string,string|null>|null;
};
const DOCS: Record<DocumentType,string> = {
  ktp:"KTP",kk:"Kartu Keluarga",sim:"SIM",npwp:"NPWP",
  ijazah:"Ijazah",skck:"SKCK",kontrak:"Kontrak Kerja",
};
const KEYS: Record<DocumentType,readonly string[]> = {
  ktp:["nik","nama_lengkap","tempat_lahir","tanggal_lahir","alamat","jenis_kelamin",
    "agama","status_perkawinan","rt_rw","kelurahan","kecamatan"],
  kk:["nomor_kk","nik","nama_lengkap","alamat","anggota_keluarga"],
  sim:["nomor_dokumen","nama_lengkap","jenis_sim","masa_berlaku"],
  npwp:["nomor_dokumen","nik","nama_lengkap","alamat"],
  ijazah:["nama_lengkap","institusi","jurusan","tahun_lulus","nomor_dokumen"],
  skck:["nama_lengkap","nomor_dokumen","masa_berlaku"],
  kontrak:["nama_lengkap","jabatan","tanggal_mulai_kontrak","tanggal_akhir_kontrak"],
};
const DOC_FORMATS = ["image/jpeg","image/png","image/webp","application/pdf"];
const MAX_SIZE=5*1024*1024;
export function HrdDocumentManager({companyId,employeeId,enabled,documents,refresh}:{
  companyId:number;employeeId:number;enabled:boolean;documents:Document[];refresh:()=>Promise<void>;
}){
  const [docType,setDocType]=useState<DocumentType>("ktp");
  const [file,setFile]=useState<File|null>(null);
  const [authorized,setAuthorized]=useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const [reviewDoc,setReviewDoc]=useState<Document|null>(null);
  const [review,setReview]=useState<Record<string,string>>({});
  const [confirmed,setConfirmed]=useState(false);
  const [preview,setPreview]=useState<{id:string;url:string;mime:string}|null>(null);
  const uploadRef=useRef<HTMLInputElement>(null);
  const generation=useRef(0);
  useEffect(()=>{
    generation.current++;
    setDocType("ktp");setFile(null);setAuthorized(false);setReviewDoc(null);
    setReview({});setConfirmed(false);setPreview(null);setNotice("");setError("");
    if(uploadRef.current)uploadRef.current.value="";
    return()=>{generation.current++;};
  },[companyId,employeeId]);
  const post=async<T,>(suffix:string,body:unknown):Promise<T>=>{
    const response=await fetch(`/api/hrd/employees/${employeeId}/documents/${suffix}?companyId=${companyId}`,{
      method:"POST",credentials:"include",cache:"no-store",headers:{"content-type":"application/json"},
      body:JSON.stringify(body),
    });
    const data=await response.json().catch(()=>({}));
    if(!response.ok)throw Error(data.message||`HTTP ${response.status}`);
    return data as T;
  };
  const selectDocument=(doc:Document)=>{
    if(doc.status!=="pending_review"||!(doc.doc_type in DOCS))return;
    const type=doc.doc_type as DocumentType;
    setReviewDoc(doc);
    setReview(Object.fromEntries(KEYS[type].map(k=>[k,doc.extracted_data?.[k]??""])));
    setConfirmed(false);setError("");setNotice("");
  };
  const uploadAndScan=async()=>{
    if(!enabled||!authorized||!file||busy)return;
    const scope=generation.current;
    setBusy(true);setError("");setNotice("");setReviewDoc(null);setPreview(null);
    try{
      // Cheap preflight using SHA-256 before creating a new private Storage object.
      // The same original File is uploaded unchanged if the preflight permits it.
      const originalSha256=await hashHrdOriginalFile(file);
      if(scope!==generation.current)return;
      const prep=await post<HrdSignedUpload>(
        "prepare",{docType,mimeType:file.type,processingAuthorizationConfirmed:true,
          ...(originalSha256?{originalSha256}:{})},
      );
      if(scope!==generation.current)return;
      await uploadHrdSignedDocument(prep,file,companyId,employeeId);
      if(scope!==generation.current)return;
      const scan=await post<{status:string;engine:string;extracted:Record<string,string|null>;warnings:string[]}>(
        `${prep.documentId}/scan`,{processingAuthorizationConfirmed:true},
      );
      if(scan.status!=="pending_review")throw Error("Status scan OCR tidak sesuai.");
      if(scope!==generation.current)return;
      setNotice(scan.engine==="local"?"OCR lokal selesai. Periksa dan koreksi hasil.":
        scan.engine==="openai_fallback"?"AI cadangan digunakan; periksa semua hasil OCR.":
        scan.engine==="manual_review_required"?
          "OCR selesai tetapi tidak mengenali informasi. Hasil kosong; periksa dokumen asli dan jangan menebak.":
          "Hasil scan perlu diperiksa dan dilengkapi HRD.");
      setFile(null);if(uploadRef.current)uploadRef.current.value="";
      await refresh();
      if(scope!==generation.current)return;
      setReviewDoc({id:prep.documentId,doc_type:docType,status:"pending_review",extracted_data:scan.extracted});
      setReview(Object.fromEntries(KEYS[docType].map(k=>[k,scan.extracted?.[k]??""])));
    }catch(cause){
      if(scope===generation.current)setError(cause instanceof Error?cause.message:"Scan gagal.");
    }finally{if(scope===generation.current)setBusy(false);}
  };
  // Reuse the existing private object; do not create a second document or upload.
  const canRetryScan=(doc:Document):boolean=>{
    if(doc.status==="scanning"||doc.status==="scan_failed")return true;
    if(doc.status!=="pending_review"||!(doc.doc_type in KEYS)||
       doc.confidence==null||Number(doc.confidence)!==0)return false;
    const keys=KEYS[doc.doc_type as DocumentType];
    return keys.length>0&&keys.every(key=>!String(doc.extracted_data?.[key]??"").trim());
  };
  const retryScan=async(doc:Document)=>{
    if(!enabled||!authorized||busy||!canRetryScan(doc))return;
    const scope=generation.current;
    setBusy(true);setError("");setNotice("");
    try{
      const scan=await post<{status:string;engine:string;extracted:Record<string,string|null>;warnings:string[]}>(
        `${doc.id}/scan`,{processingAuthorizationConfirmed:true},
      );
      if(scan.status!=="pending_review")throw Error("Status scan OCR tidak sesuai.");
      if(scope!==generation.current)return;
      setNotice(scan.engine==="manual_review_required"?
        "Mesin OCR selesai tetapi tidak mengenali informasi dokumen. Hasil kosong; buka Lihat Dokumen, periksa aslinya, lalu isi hanya data yang benar-benar terbaca.":
        "OCR diproses ulang dari file yang sudah tersimpan. Periksa hasilnya.");
      await refresh();
      if(scope!==generation.current)return;
      setReviewDoc({id:doc.id,doc_type:doc.doc_type,status:"pending_review",extracted_data:scan.extracted});
      setReview(Object.fromEntries(KEYS[doc.doc_type as DocumentType].map(k=>[k,scan.extracted?.[k]??""])));
    }catch(cause){
      if(scope===generation.current)setError(cause instanceof Error?cause.message:"Pemrosesan ulang gagal.");
      await refresh().catch(()=>undefined);
    }finally{if(scope===generation.current)setBusy(false);}
  };
  const approve=async()=>{
    if(!enabled||!reviewDoc||!confirmed||busy)return;
    const scope=generation.current;
    setBusy(true);setError("");
    try{
      const fields=Object.fromEntries(Object.entries(review).map(([k,v])=>[k,v.trim()||null]));
      const result=await post<{status:string}>(`${reviewDoc.id}/verify`,{fields,confirm:true});
      if(result.status!=="verified")throw Error("Verifikasi dokumen gagal.");
      if(scope!==generation.current)return;
      setNotice("Dokumen berhasil diverifikasi dan disimpan pada profil HRD.");
      setReviewDoc(null);setConfirmed(false);await refresh();
    }catch(cause){if(scope===generation.current)setError(cause instanceof Error?cause.message:"Verifikasi gagal.");}
    finally{if(scope===generation.current)setBusy(false);}
  };
  const showPreview=async(doc:Document)=>{
    if(!enabled||busy)return;
    const scope=generation.current;setBusy(true);setError("");
    try{
      const result=await post<{url:string;expiresIn:number}>(`${doc.id}/preview`,{});
      if(!result.url.startsWith("https://nzdweipzckfszczzqtuw.supabase.co/storage/v1/object/sign/"))throw Error("URL privat tidak valid.");
      if(scope===generation.current)setPreview({id:doc.id,url:result.url,mime:doc.mime_type??""});
    }catch(cause){if(scope===generation.current)setError(cause instanceof Error?cause.message:"Preview gagal.");}
    finally{if(scope===generation.current)setBusy(false);}
  };
  return <div className="space-y-4 rounded-xl border p-4">
    <div><h2 className="flex items-center gap-2 text-lg font-semibold"><FileText className="h-5 w-5" /> Scan Dokumen HRD</h2>
      <p className="text-xs text-muted-foreground">OCR lokal terlebih dahulu; OpenAI hanya dipakai bila hasil kurang lengkap dan fallback diaktifkan.</p>
    </div>
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="space-y-1 text-sm"><span>Jenis dokumen</span>
        <select className="w-full rounded-md border bg-background px-3 py-2" value={docType}
          onChange={e=>{setDocType(e.target.value as DocumentType);setFile(null);if(uploadRef.current)uploadRef.current.value="";}}>
          {Object.entries(DOCS).map(([key,name])=><option key={key} value={key}>{name}</option>)}
        </select>
      </label>
      <label className="space-y-1 text-sm"><span>File dokumen (maks. 5 MB)</span>
        <input ref={uploadRef} type="file" accept="image/jpeg,image/png,image/webp,application/pdf"
          className="block w-full text-sm" onChange={e=>{
            const next=e.target.files?.[0]??null;
            if(next && (next.size===0||next.size>MAX_SIZE||!DOC_FORMATS.includes(next.type))){
              setError("Dokumen harus PDF/JPG/PNG/WEBP, maksimal 5 MB.");setFile(null);return;
            }
            setError("");setFile(next);
          }} />
      </label>
    </div>
    <label className="flex items-start gap-2 text-xs">
      <Checkbox checked={authorized} onCheckedChange={value=>setAuthorized(value===true)} disabled={!enabled} />
      <span>Saya berwenang memproses dokumen karyawan ini dan menyetujui OCR lokal serta kemungkinan penggunaan AI cadangan.</span>
    </label>
    <Button disabled={!enabled||!authorized||!file||busy} onClick={()=>void uploadAndScan()} className="w-full sm:w-auto">
      <Upload className="mr-2 h-4 w-4" />{busy?"Sedang diproses...":enabled?"Unggah & Scan Dokumen":"OCR belum aktif"}
    </Button>
    {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
    {notice&&<p role="status" className="text-sm text-muted-foreground">{notice}</p>}
    {documents.filter(d=>d.doc_type!=="foto").map(doc=><div key={doc.id} className="space-y-2 rounded-lg border p-3 text-sm">
      <p className="font-medium">{DOCS[doc.doc_type as DocumentType]??doc.doc_type} · {doc.status}</p>
      <div className="flex flex-wrap gap-2">
        {(doc.status==="pending_review"||doc.status==="verified")&&<Button variant="outline" size="sm" disabled={!enabled||busy} onClick={()=>void showPreview(doc)}>Lihat Dokumen</Button>}
        {doc.status==="pending_review"&&<Button variant="outline" size="sm" disabled={!enabled||busy} onClick={()=>selectDocument(doc)}>Periksa / Koreksi</Button>}
        {canRetryScan(doc)&&<Button variant="outline" size="sm" disabled={!enabled||busy||!authorized} onClick={()=>void retryScan(doc)}>{doc.status==="pending_review"?"Ulang OCR File Ini":"Coba Scan Lagi"}</Button>}
      </div>
      {preview?.id===doc.id&&(preview.mime==="application/pdf"
        ?<iframe title="Preview privat dokumen HRD" src={preview.url} className="h-96 w-full rounded-lg border" />
        :<img src={preview.url} alt="Preview privat dokumen HRD" className="max-h-96 rounded-lg border object-contain" />)}
    </div>)}
    {reviewDoc&&reviewDoc.doc_type in DOCS&&<div className="space-y-3 rounded-lg border bg-muted/20 p-3">
      <h3 className="flex items-center gap-2 font-semibold"><ShieldCheck className="h-4 w-4" /> Pemeriksaan HRD</h3>
      <p className="text-xs text-muted-foreground">Perbaiki hasil sebelum mengesahkan. Data tidak langsung mengubah master karyawan atau Payroll.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {KEYS[reviewDoc.doc_type as DocumentType].map(k=><label key={k} className="space-y-1 text-xs">
          <span className="capitalize">{k.replaceAll("_"," ")}</span>
          {k==="anggota_keluarga"
            ?<textarea className="min-h-24 w-full rounded-md border bg-background p-2" value={review[k]??""} onChange={e=>setReview(v=>({...v,[k]:e.target.value}))} />
            :<Input value={review[k]??""} onChange={e=>setReview(v=>({...v,[k]:e.target.value}))} />}
        </label>)}
      </div>
      <label className="flex items-center gap-2 text-sm"><Checkbox checked={confirmed} onCheckedChange={v=>setConfirmed(v===true)} />Saya sudah memeriksa dokumen asli dan menyetujui koreksi.</label>
      <Button disabled={!enabled||!confirmed||busy} onClick={()=>void approve()}>Sahkan Hasil OCR</Button>
    </div>}
  </div>;
}
