import {useEffect,useMemo,useState} from "react";
import {Link} from "wouter";
import {AppShell} from "@/components/layout/AppShell";
import {useCompany} from "@/contexts/CompanyContext";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {Badge} from "@/components/ui/badge";
import {ArrowLeft,RefreshCcw,Search,UserRound} from "lucide-react";

type Employee={
 id:number;first_name:string;last_name:string|null;status:string;
 email:string|null;phone:string|null;position:string|null;hire_date:string|null;
};
type Directory={companyId:number;employees:Employee[];readOnly:boolean};
export default function HrdEmployeeDirectory(){
 const {activeCompanyId,isConsolidated}=useCompany();
 const companyId=isConsolidated?null:Number(activeCompanyId);
 const [rows,setRows]=useState<Employee[]>([]);
 const [search,setSearch]=useState("");
 const [loading,setLoading]=useState(false);
 const [error,setError]=useState("");
 const load=async()=>{
  if(companyId===null||!Number.isSafeInteger(companyId)||companyId<1){
   setRows([]);setError("Pilih satu perusahaan untuk membuka Master Karyawan.");return;
  }
  setLoading(true);setError("");
  try{
   const response=await fetch(`/api/payroll/hrd/employees?companyId=${companyId}`,{
    credentials:"include",cache:"no-store"
   });
   const payload=await response.json().catch(()=>({}));
   if(!response.ok)throw Error(payload.message??`HTTP ${response.status}`);
   const data=payload as Directory;
   if(data.companyId!==companyId||!Array.isArray(data.employees))throw Error("Respons perusahaan tidak cocok.");
   setRows(data.employees);
  }catch(e){setRows([]);setError(e instanceof Error?e.message:"Daftar karyawan tidak dapat dimuat.");}
  finally{setLoading(false);}
 };
 useEffect(()=>{void load();},[companyId]);
 const filtered=useMemo(()=>{
  const q=search.trim().toLowerCase();
  return q?rows.filter(x=>[`${x.first_name} ${x.last_name??""}`,x.position??"",x.email??"",String(x.id)].some(v=>v.toLowerCase().includes(q))):rows;
 },[rows,search]);
 return <AppShell>
  <div className="mx-auto max-w-6xl space-y-5 p-5">
   <Link href="/hr" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
    <ArrowLeft className="h-4 w-4"/> HR & Payroll
   </Link>
   <section className="flex flex-wrap items-center gap-3 rounded-xl border bg-card p-4">
    <div className="rounded-xl bg-primary/10 p-3"><UserRound className="h-6 w-6 text-primary"/></div>
    <div className="min-w-0 flex-1">
     <h1 className="text-xl font-semibold">Master Karyawan</h1>
     <p className="text-sm text-muted-foreground">Profil dan dokumen karyawan per perusahaan.</p>
    </div>
    <Button variant="outline" size="sm" onClick={()=>void load()} disabled={loading}>
     <RefreshCcw className={`mr-2 h-4 w-4 ${loading?"animate-spin":""}`}/> Muat ulang
    </Button>
   </section>
   {error&&<p role="alert" className="rounded-md border border-red-800 bg-red-950/20 p-3 text-sm text-red-400">{error}</p>}
   <div className="flex flex-wrap items-center gap-3">
    <div className="relative min-w-[220px] flex-1">
     <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"/>
     <Input className="pl-9" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Cari nama, jabatan, email, atau ID"/>
    </div>
    <Badge variant="secondary">{filtered.length} karyawan</Badge>
   </div>
   <div className="overflow-hidden rounded-xl border">
    <div className="grid grid-cols-[minmax(0,1fr)_140px_120px] gap-3 border-b bg-muted/40 px-4 py-3 text-xs font-medium text-muted-foreground">
     <span>Nama Karyawan</span><span>Jabatan</span><span>Status</span>
    </div>
    {loading?<p className="p-5 text-sm text-muted-foreground">Memuat daftar karyawan…</p>
     :filtered.length===0?<p className="p-5 text-sm text-muted-foreground">Tidak ada karyawan yang cocok.</p>
     :filtered.map(employee=><Link key={employee.id} href={`/hr/employees/${employee.id}`}
       className="grid grid-cols-[minmax(0,1fr)_140px_120px] items-center gap-3 border-b px-4 py-3 last:border-b-0 hover:bg-muted/40">
       <div className="min-w-0">
        <p className="truncate text-sm font-medium">{employee.first_name} {employee.last_name??""}</p>
        <p className="truncate text-xs text-muted-foreground">ID {employee.id}{employee.email?" · "+employee.email:""}</p>
       </div>
       <span className="truncate text-sm text-muted-foreground">{employee.position??"—"}</span>
       <Badge variant={employee.status==="active"?"secondary":"outline"}>{employee.status}</Badge>
      </Link>)}
   </div>
   <p className="text-xs text-muted-foreground">Dokumen HRD hanya dapat diakses Owner/Super Admin yang berwenang. File tersimpan privat dan tidak dapat diakses publik.</p>
  </div>
 </AppShell>;
}
