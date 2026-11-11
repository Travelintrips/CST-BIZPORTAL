import {useEffect,useState,useRef} from "react";
import {Link,useLocation} from "wouter";
import {AppShell} from "@/components/layout/AppShell";
import {useCompany} from "@/contexts/CompanyContext";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {Textarea} from "@/components/ui/textarea";
import {hrdScanFailureMessage} from "@/lib/hrdOcrError";
import {Badge} from "@/components/ui/badge";
import {Camera,Upload,ScanLine,ShieldCheck,FileText,Lock,ArrowLeft,
 UserRound,BriefcaseBusiness,Wallet,History,FolderOpen} from "lucide-react";

type DocType="ktp"|"kk"|"sim"|"npwp"|"ijazah"|"skck"|"foto"|"kontrak";
type Doc={
 id:string;doc_type:DocType;mime_type:string;status:string;
 confidence:number|null;warnings:string[];extracted_data:Record<string,string|null>;
 verified_data?:Record<string,string|null>;
 created_at:string;verified_at:string|null;
};
type HrdView={
 companyId:number;employeeId:number;
 employee:{id:number;first_name:string;last_name:string;status:string;
  phone:string|null;email:string|null;position:string|null;hire_date:string|null};
 verifiedProfile:Record<string,string|null>;
 documents:Doc[];
 audit:Array<{action:string;actor:string;changed_fields:string[];approved_data?:Record<string,string|null>;created_at:string}>;
 readOnly:boolean;
};
const docLabels:Record<DocType,string>={
 ktp:"KTP",kk:"Kartu Keluarga",sim:"SIM",npwp:"NPWP",ijazah:"Ijazah",
 skck:"SKCK",foto:"Pas Foto",kontrak:"Kontrak Kerja"
};
const identityFieldKeys=["nik","nama_lengkap","tempat_lahir","tanggal_lahir","alamat","nomor_kk",
 "anggota_keluarga","jenis_kelamin","agama","status_perkawinan","rt_rw","kelurahan","kecamatan"] as const;
const fieldLabels:Record<string,string>={
 nik:"NIK",nama_lengkap:"Nama Lengkap",tempat_lahir:"Tempat Lahir",
 tanggal_lahir:"Tanggal Lahir",alamat:"Alamat",nomor_kk:"Nomor KK",
 anggota_keluarga:"Anggota Keluarga (Nama | Hubungan | Tanggal Lahir)",
 jenis_kelamin:"Jenis Kelamin",agama:"Agama",status_perkawinan:"Status Perkawinan",
 rt_rw:"RT/RW",kelurahan:"Kelurahan",kecamatan:"Kecamatan",
 nomor_dokumen:"Nomor Dokumen",jenis_sim:"Jenis SIM",masa_berlaku:"Masa Berlaku",
 institusi:"Instansi / Sekolah",jurusan:"Jurusan",tahun_lulus:"Tahun Lulus",
 jabatan:"Jabatan",tanggal_mulai_kontrak:"Mulai Kontrak",
 tanggal_akhir_kontrak:"Akhir Kontrak",
};
function ocrEngineNotice(engine:string|undefined){
 if(engine==="local")return "OCR lokal berhasil. Dokumen tidak dikirim ke OpenAI dan tidak menggunakan kredit API.";
 if(engine==="openai_fallback")return "OCR lokal belum cukup lengkap. OpenAI digunakan sebagai cadangan dan dapat menggunakan kredit API; hasil wajib diperiksa HRD.";
 if(engine==="openai_fallback_failed")return "AI cadangan gagal. Hasil lokal perlu diperiksa manual; pemakaian kredit bergantung pada apakah penyedia sempat memproses permintaan.";
 if(engine==="local_manual_review")return "OCR lokal belum lengkap. AI cadangan tidak aktif, sehingga tidak ada permintaan OpenAI. Lengkapi hasil secara manual.";
 if(engine==="not_required")return "Pas foto tidak memerlukan OCR.";
 return "Hasil OCR perlu dilengkapi atau dikoreksi HRD.";
}
async function api<T>(url:string,method="GET",body?:unknown):Promise<T>{
 const resp=await fetch(url,{
  method,credentials:"include",cache:"no-store",
  headers:{"Content-Type":"application/json"},
  body:body===undefined?undefined:JSON.stringify(body),
 });
 const result=await resp.json().catch(()=>({}));
 if(!resp.ok)throw Error(result.message??`HTTP ${resp.status}`);
 return result as T;
}
export default function HrdEmployeeDetail(){
 const [location]=useLocation();
 const id=Number(location.split("/").filter(Boolean).at(-1));
 const {activeCompanyId,isConsolidated}=useCompany();
 const companyId=isConsolidated?null:Number(activeCompanyId);
 const [data,setData]=useState<HrdView|null>(null);
 const [tab,setTab]=useState<"identitas"|"dokumen"|"pekerjaan"|"gaji"|"riwayat">("dokumen");
 const [type,setType]=useState<DocType>("ktp");
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState("");
 const [notice,setNotice]=useState("");
 const [selectedDoc,setSelectedDoc]=useState<Doc|null>(null);
 const [review,setReview]=useState<Record<string,string>>({});
 const [confirmed,setConfirmed]=useState(false);
 const [processingAuthorized,setProcessingAuthorized]=useState(false);
 const fileInput=useRef<HTMLInputElement>(null);
 const requestSeq=useRef(0);
 const load=async()=>{
  const seq=++requestSeq.current;
  setError("");
  if(companyId===null||!Number.isSafeInteger(companyId)||companyId<1||!Number.isSafeInteger(id)||id<1){
   setData(null);setError("Pilih perusahaan CST untuk mengelola dokumen HRD.");return;
  }
  try{
   const result=await api<HrdView>(`/api/payroll/hrd/employees/${id}?companyId=${companyId}`);
   if(seq!==requestSeq.current)return;
   if(result.companyId!==companyId||result.employeeId!==id)throw Error("Perusahaan/ID tidak cocok.");
   setData(result);
  }catch(e){
   if(seq===requestSeq.current){setError(e instanceof Error?e.message:"Data tidak dapat dibaca.");setData(null);}
  }
 };
 useEffect(()=>{setData(null);setSelectedDoc(null);setReview({});setConfirmed(false);void load();
  return()=>{requestSeq.current++;};
 },[companyId,id]);
 const chooseDoc=(doc:Doc)=>{
  setSelectedDoc(doc);setReview(Object.fromEntries(
   Object.entries(doc.extracted_data??{}).map(([k,v])=>[k,v??""])
  ));setConfirmed(false);setError("");
 };
 const scan=async(file:File)=>{
  if(busy||!data||data.readOnly)return;
  if(!processingAuthorized){setError("Konfirmasi kewenangan dan persetujuan pemrosesan dokumen terlebih dahulu.");return;}
  if(file.size===0||file.size>5*1024*1024){
   setError("Maksimal file 5 MB.");return;
  }
  if(!["image/jpeg","image/png","image/webp","application/pdf"].includes(file.type)){
   setError("Gunakan JPG, PNG, WEBP, atau PDF.");return;
  }
  const currentId=id;
  setBusy(true);setError("");setNotice("");setSelectedDoc(null);setConfirmed(false);
  try{
   const prepared=await api<{
    documentId:string;path:string;token:string;
    storageUrl:string;bucket:string;maxBytes:number
   }>(`/api/payroll/hrd/employees/${currentId}/documents/prepare?companyId=${companyId}`,
    "POST",{docType:type,mimeType:file.type,processingAuthorizationConfirmed:true});
   if(currentId!==id)return;
   // Scoped one-time signed upload. No service key or public Storage policy in the browser.
   const storageUrl=`${prepared.storageUrl}/storage/v1/object/upload/sign/${prepared.bucket}/${prepared.path}?token=${encodeURIComponent(prepared.token)}`;
   const uploaded=await fetch(storageUrl,{
    method:"PUT",headers:{"Content-Type":file.type,"x-upsert":"false"},
    body:file
   });
   if(!uploaded.ok)throw Error("Upload privat gagal. Silakan ulangi.");
   const result=await api<{
    documentId:string;status:string;extracted:Record<string,string|null>;
    confidence:number;warnings:string[];requiresVerification:boolean;engine?:string;
   }>(`/api/payroll/hrd/employees/${currentId}/documents/${prepared.documentId}/scan?companyId=${companyId}`,"POST",{processingAuthorizationConfirmed:true});
   if(result.status!=="pending_review"||!result.requiresVerification)
    throw Error("Dokumen belum siap diperiksa.");
   await load();
   chooseDoc({
    id:result.documentId,doc_type:type,mime_type:file.type,status:result.status,
    extracted_data:result.extracted,confidence:result.confidence,
    warnings:result.warnings,created_at:new Date().toISOString(),verified_at:null
   });
   setNotice(ocrEngineNotice(result.engine)+" Periksa nilai dan konfirmasi sebelum menyimpan.");
  }catch(e){await load();setError(hrdScanFailureMessage(e instanceof Error?e.message:"Scan gagal."));}
  finally{setBusy(false);if(fileInput.current)fileInput.current.value="";}
 };
 const retryScan=async(doc:Doc)=>{
  if(busy||!data||data.readOnly||doc.status!=="scan_failed")return;
  if(!processingAuthorized){
   setError("Konfirmasi kewenangan dan persetujuan pemrosesan dokumen terlebih dahulu.");return;
  }
  setBusy(true);setError("");setNotice("");setSelectedDoc(null);setConfirmed(false);
  try{
   // No new upload or database document. Reuse the existing private object.
   const result=await api<{
    documentId:string;status:string;extracted:Record<string,string|null>;
    confidence:number;warnings:string[];requiresVerification:boolean;engine?:string;
   }>(`/api/payroll/hrd/employees/${id}/documents/${doc.id}/scan?companyId=${companyId}`,"POST",{processingAuthorizationConfirmed:true});
   if(result.status!=="pending_review"||!result.requiresVerification)
    throw Error("Dokumen belum siap diperiksa.");
   await load();
   chooseDoc({...doc,status:"pending_review",extracted_data:result.extracted,
    confidence:result.confidence,warnings:result.warnings});
   setNotice(ocrEngineNotice(result.engine)+" Periksa hasil sebelum menyimpan.");
  }catch(e){
   await load();
   setError(hrdScanFailureMessage(e instanceof Error?e.message:"Scan ulang gagal."));
  }finally{setBusy(false);}
 };
 const verify=async()=>{
  if(!selectedDoc||!confirmed||busy)return;
  setBusy(true);setError("");setNotice("");
  try{
   const saved=await api<{status:string;profileUpdated:boolean}>(
    `/api/payroll/hrd/employees/${id}/documents/${selectedDoc.id}/verify?companyId=${companyId}`,
    "POST",{confirm:true,fields:review});
   if(saved.status!=="verified")throw Error("Verifikasi gagal.");
   setNotice(saved.profileUpdated?
    "Dokumen disahkan. Profil HRD diperbarui tanpa menimpa master lama.":
    "Dokumen disahkan. Tidak ada perubahan data identitas.");
   setSelectedDoc(null);setReview({});setConfirmed(false);await load();
  }catch(e){setError(e instanceof Error?e.message:"Penyimpanan gagal.");}
  finally{setBusy(false);}
 };
 const preview=async(doc:Doc)=>{
  try{
   const signed=await api<{url:string;expiresIn:number}>(
    `/api/payroll/hrd/employees/${id}/documents/${doc.id}/preview?companyId=${companyId}`,"POST",{});
   window.open(signed.url,"_blank","noopener,noreferrer");
  }catch(e){setError(e instanceof Error?e.message:"Pratinjau gagal.");}
 };
 const visible=data?.documents??[];
 return <AppShell>
  <div className="p-5 space-y-4 max-w-6xl mx-auto">
   <Link href="/hr/employees" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
    <ArrowLeft className="h-4 w-4"/> Master Karyawan
   </Link>
   <section className="rounded-xl border bg-card p-4">
    <div className="flex items-start gap-3">
     <div className="rounded-xl bg-sky-900/20 p-4"><UserRound className="h-7 w-7 text-sky-400"/></div>
     <div className="flex-1">
      <h1 className="text-xl font-semibold">{data?
       `${data.employee.first_name} ${data.employee.last_name??""}`:"Detail Karyawan"}</h1>
      <p className="text-xs text-muted-foreground">ID {id} · PT Cahaya Sejati Teknologi</p>
      {data&&<Badge variant="secondary" className="mt-2">{data.employee.status}</Badge>}
     </div>
    </div>
   </section>
   {error&&<p role="alert" className="rounded-md border border-red-800 bg-red-950/20 p-3 text-sm text-red-400">{error}</p>}
   {notice&&<p role="status" className="rounded-md border p-3 text-sm text-emerald-500">{notice}</p>}
   <div role="tablist" aria-label="Detail Karyawan" className="flex flex-wrap gap-2">
    {([
     ["identitas","Identitas",UserRound],["dokumen","Dokumen",FolderOpen],
     ["pekerjaan","Pekerjaan",BriefcaseBusiness],["gaji","Gaji",Wallet],
     ["riwayat","Riwayat",History]
    ] as const).map(([name,label,Icon])=>
     <Button key={name} role="tab" aria-selected={tab===name}
      variant={tab===name?"default":"outline"} size="sm" onClick={()=>setTab(name)}>
      <Icon className="h-4 w-4 mr-1"/>{label}</Button>)}
   </div>
   {data&&tab==="identitas"&&<section className="rounded-xl border p-4 space-y-3">
    <h2 className="font-semibold">Identitas Terverifikasi</h2>
    <p className="text-xs text-muted-foreground">Data diambil dari hasil OCR yang sudah diperiksa HRD. Master lama tidak ditimpa otomatis.</p>
    <div className="grid gap-3 md:grid-cols-2">
     {identityFieldKeys.map(k=><div key={k} className="rounded-md border p-3 text-sm">
      <p className="text-xs text-muted-foreground">{fieldLabels[k]}</p>
      <p className="font-medium">{data.verifiedProfile[k]||"Belum diverifikasi"}</p></div>)}
    </div>
   </section>}
   {data&&tab==="dokumen"&&<div className="grid lg:grid-cols-2 gap-4">
    <section className="rounded-xl border p-4 space-y-3">
     <h2 className="font-semibold">Upload & OCR Dokumen</h2>
     <p className="text-xs text-muted-foreground">OCR lokal diprioritaskan tanpa kredit API. OpenAI hanya menjadi cadangan jika hasil lokal kurang lengkap; pemakaian cadangan dapat menggunakan kredit API. Seluruh dokumen tersimpan privat.</p>
     <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
      {(Object.entries(docLabels) as [DocType,string][]).map(([k,label])=>
       <Button size="sm" key={k} variant={type===k?"default":"outline"}
        onClick={()=>setType(k)}>{label}</Button>)}
     </div>
     <label className="flex items-start gap-2 text-xs">
      <input type="checkbox" checked={processingAuthorized}
       onChange={e=>setProcessingAuthorized(e.target.checked)}/>
      Saya berwenang memproses dokumen karyawan ini, termasuk ekstraksi oleh layanan OCR pihak ketiga,
      dan sudah memastikan pemberitahuan/persetujuan yang diperlukan.
     </label>
     <input ref={fileInput} type="file"
      accept={type==="foto"?"image/*":".pdf,image/jpeg,image/png,image/webp"}
      capture={type==="foto"?"user":undefined}
      className="hidden" onChange={e=>{const f=e.target.files?.[0];if(f)void scan(f)}}/>
     <Button disabled={busy||data.readOnly||!processingAuthorized} onClick={()=>fileInput.current?.click()}>
      {busy?<ScanLine className="mr-2 h-4 w-4 animate-pulse"/>:<Camera className="mr-2 h-4 w-4"/>}
      {busy?"Mengunggah dan membaca...":type==="foto"?"Ambil Pas Foto / Upload":"Scan / Upload "+docLabels[type]}
     </Button>
     {type==="foto"&&<p className="text-xs text-muted-foreground">Di HP, tombol ini meminta kamera depan. Di PC/laptop, pilih foto dari perangkat. Ketersediaan kamera mengikuti izin browser dan perangkat.</p>}
     {data.readOnly&&<p className="text-amber-500 text-xs">Upload OCR belum aktif di server DEV. Konfigurasi privat diperlukan.</p>}
     <div className="space-y-2">
      <h3 className="font-medium text-sm">Dokumen Tersimpan</h3>
      {visible.length===0&&<p className="text-xs text-muted-foreground">Belum ada dokumen HRD yang diunggah.</p>}
      {visible.some(doc=>doc.status==="scan_failed")&&<p className="text-xs text-amber-500">Scan gagal tidak mengubah profil. Jangan unggah berkas yang sama lagi; gunakan Coba scan lagi setelah layanan OCR pulih. Konfirmasi kewenangan di atas terlebih dahulu.</p>}
      {visible.map(doc=><div key={doc.id} className="border rounded-lg p-2 space-y-2 text-xs">
       <div className="flex items-center gap-2">
        <FileText className="h-5 w-5 text-muted-foreground"/>
        <span className="flex-1">{docLabels[doc.doc_type]??doc.doc_type}
         <span className="block text-muted-foreground">{doc.status} · {new Date(doc.created_at).toLocaleDateString("id-ID")}</span>
        </span>
        <Button size="sm" variant="outline" onClick={()=>void preview(doc)}>Lihat</Button>
        {doc.status==="pending_review"&&<Button size="sm" onClick={()=>chooseDoc(doc)}>Periksa</Button>}
        {doc.status==="scan_failed"&&<Button size="sm" variant="outline"
         disabled={busy||data.readOnly||!processingAuthorized}
         onClick={()=>void retryScan(doc)}>Coba scan lagi</Button>}
       </div>
       {doc.status==="verified"&&Object.keys(doc.verified_data??{}).length>0&&
        <details className="rounded-md bg-muted/40 p-2">
         <summary className="cursor-pointer font-medium">Data dokumen terverifikasi</summary>
         <div className="mt-2 grid gap-1 sm:grid-cols-2">
          {Object.entries(doc.verified_data??{}).map(([key,value])=>
           <p key={key}><span className="text-muted-foreground">{fieldLabels[key]??key}: </span>{value||"—"}</p>)}
         </div>
        </details>}
      </div>)}
     </div>
    </section>
    <section className="rounded-xl border p-4 space-y-3">
     <h2 className="font-semibold flex items-center gap-2"><ShieldCheck className="h-4 w-4"/> Verifikasi Hasil OCR</h2>
     {!selectedDoc&&<p className="text-sm text-muted-foreground">
      Unggah dokumen atau pilih Periksa pada dokumen yang menunggu verifikasi.</p>}
     {selectedDoc&&<>
      <p className="text-xs text-muted-foreground">Dokumen: {docLabels[selectedDoc.doc_type]} · Confidence OCR: {Math.round((selectedDoc.confidence??0)*100)}%</p>
      {(selectedDoc.warnings??[]).map((w,i)=><p key={i} className="text-xs text-amber-500">{w}</p>)}
      <div className="max-h-[410px] overflow-y-auto space-y-2">
       {Object.entries(fieldLabels).filter(([key])=>review[key]!==undefined).map(([key,label])=>
        <label key={key} className="block text-xs">{label}
         {key==="anggota_keluarga"?<Textarea className="mt-1 min-h-32" value={review[key]??""}
          placeholder="Satu orang per baris: Nama | Hubungan | YYYY-MM-DD"
          maxLength={4000} onChange={e=>setReview(v=>({...v,[key]:e.target.value}))}/>
         :<Input className="mt-1" value={review[key]??""} placeholder="Tidak terbaca"
          onChange={e=>setReview(v=>({...v,[key]:e.target.value}))}/>}
        </label>)}
      </div>
      <label className="flex items-start gap-2 text-xs">
       <input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>
       Saya sudah membandingkan hasil OCR dengan dokumen asli dan menyetujui data yang benar.
      </label>
      <Button disabled={!confirmed||busy} onClick={()=>void verify()}>
       <Upload className="h-4 w-4 mr-2"/> Konfirmasi & Simpan Profil HRD
      </Button>
      <p className="text-xs text-muted-foreground">Simpan hanya memperbarui profil HRD yang telah diperiksa; tidak mengubah Payroll, kasbon atau master lama.</p>
     </>}
    </section>
   </div>}
   {data&&tab==="pekerjaan"&&<section className="rounded-xl border p-4 space-y-3">
    <h2 className="font-semibold">Data Pekerjaan</h2>
    <div className="grid md:grid-cols-2 gap-3 text-sm">
     <p>Jabatan: <strong>{data.employee.position||"Belum diisi"}</strong></p>
     <p>Mulai Bekerja: <strong>{data.employee.hire_date||"Belum diisi"}</strong></p>
     <p>Email: <strong>{data.employee.email||"Belum diisi"}</strong></p>
     <p>No. HP: <strong>{data.employee.phone||"Belum diisi"}</strong></p>
    </div>
    <p className="text-xs text-muted-foreground">Aktif/nonaktif dan perubahan kontrak harus melalui modul Master HRD terotorisasi dengan audit; OCR tidak mengubah status karyawan.</p>
   </section>}
   {data&&tab==="gaji"&&<section className="rounded-xl border p-4 space-y-2">
    <h2 className="font-semibold">Gaji & Kasbon</h2>
    <p className="text-sm">Komponen gaji berasal dari Struktur Gaji BizPortal. Nilai master lama belum otomatis dikategorikan.</p>
    <Link href="/hr/salary-structure" className="text-sky-400 text-sm underline">Buka Struktur Gaji</Link>
    <p className="text-xs text-muted-foreground flex gap-2 items-center"><Lock className="h-4 w-4"/> OCR tidak mengubah nominal gaji atau saldo kasbon.</p>
   </section>}
   {data&&tab==="riwayat"&&<section className="rounded-xl border p-4 space-y-3">
    <h2 className="font-semibold">Riwayat Audit HRD</h2>
    {(data.audit??[]).length===0&&<p className="text-xs text-muted-foreground">Belum ada perubahan dokumen.</p>}
    {(data.audit??[]).map((row,i)=><div key={i} className="border-b py-2 text-sm">
     <strong className="capitalize">{row.action.replace("_"," ")}</strong>
     <p className="text-xs text-muted-foreground">{new Date(row.created_at).toLocaleString("id-ID")} · {row.actor}</p>
     <p className="text-xs text-muted-foreground">Field: {(row.changed_fields??[]).join(", ")||"Status dokumen"}</p>
      {Object.keys(row.approved_data??{}).length>0&&<div className="mt-1 text-xs">
       {Object.entries(row.approved_data??{}).map(([key,value])=>
        <p key={key}><span className="text-muted-foreground">{fieldLabels[key]??key}: </span>{value||"—"}</p>)}
      </div>}
    </div>)}
   </section>}
  </div>
 </AppShell>;
}
