import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

export type HistoricalCandidate = {
  employeeId:number;
  employeeName:string;
  sourceRunId:number|null;
  sourceYear:number|null;
  sourceMonth:number|null;
  proposedBaseSalary:string|null;
  historicalKasbonNeedsReview:boolean;
  alreadyConfigured:boolean;
  status:"NEEDS_HR_CONFIRMATION"|"NO_HISTORICAL_SOURCE"|"ALREADY_CONFIGURED"|"INVALID_HISTORICAL_SOURCE";
};
type Review = {
  companyId:number;year:number;month:number;effectiveThrough:string;
  summary:{
    employeeCount:number;
    candidatesNeedingHrConfirmation:number;
    noHistoricalSource:number;
    invalidHistoricalSource:number;
    alreadyConfigured:number;
    historicalKasbonNeedsReview:number;
  };
  rows:HistoricalCandidate[];
  readOnly:true;reviewRequired:true;canBulkImport:false;canApply:false;
  canPay:false;canPostJournal:false;
};
const money=(value:string)=>new Intl.NumberFormat("id-ID",{
  style:"currency",currency:"IDR",maximumFractionDigits:2,
}).format(Number(value));

/** Existing Payroll configuration screen: reference data only, never an import writer. */
export function PayrollHistoricalSalaryReview({
  companyId,canPrefill,onPrefill,
}:{
  companyId:number;
  canPrefill:boolean;
  onPrefill:(candidate:HistoricalCandidate,year:number,month:number)=>void;
}) {
  const now=new Date();
  const [year,setYear]=useState(now.getFullYear());
  const [month,setMonth]=useState(now.getMonth()+1);
  const [reload,setReload]=useState(0);
  const [review,setReview]=useState<Review|null>(null);
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState("");
  useEffect(()=>{
    let active=true;
    setReview(null);setError("");setLoading(true);
    const params=new URLSearchParams({
      companyId:String(companyId),year:String(year),month:String(month),
    });
    fetch("/api/payroll/historical-salary-review?"+params.toString(),{
      credentials:"include",cache:"no-store",
    })
      .then(async r=>{
        const data=await r.json().catch(()=>({})) as Partial<Review>&{message?:string};
        if(!r.ok)throw Error(data.message??"Pratinjau referensi gaji tidak tersedia.");
        if(data.companyId!==companyId||data.year!==year||data.month!==month||
           data.readOnly!==true||data.canBulkImport!==false||
           !Array.isArray(data.rows)||!data.summary)
          throw Error("Sumber gaji historis tidak sesuai perusahaan atau periode.");
        return data as Review;
      })
      .then(data=>{if(active)setReview(data);})
      .catch(e=>{if(active)setError(e instanceof Error?e.message:"Gagal memuat pratinjau.");})
      .finally(()=>{if(active)setLoading(false);});
    return()=>{active=false};
  },[companyId,year,month,reload]);
  const visible=review?.companyId===companyId && review?.year===year && review?.month===month
    ? review:null;
  return <section aria-label="Pratinjau referensi gaji historis" className="rounded-lg border p-4 space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 className="font-semibold text-lg">Pratinjau Impor Gaji Historis</h2>
        <p className="text-xs text-muted-foreground">
          Sumber: item Payroll periode sebelumnya yang telah disetujui dan diposting.
          Gaji historis bukan persetujuan HRD untuk periode saat ini.
        </p>
      </div>
      <Button variant="outline" size="sm" onClick={()=>setReload(v=>v+1)} disabled={loading}>
        Periksa Ulang
      </Button>
    </div>
    <div className="flex flex-wrap gap-3 text-sm">
      <label>Bulan
        <select aria-label="Bulan referensi gaji" className="ml-2 rounded border bg-background p-2"
          value={month} onChange={e=>setMonth(Number(e.target.value))}>
          {Array.from({length:12},(_,i)=><option key={i+1} value={i+1}>
            {new Intl.DateTimeFormat("id-ID",{month:"long"}).format(new Date(2026,i,1))}
          </option>)}
        </select>
      </label>
      <label>Tahun
        <input aria-label="Tahun referensi gaji" type="number" className="ml-2 w-24 rounded border bg-background p-2"
          min={2020} max={2099} value={year} onChange={e=>setYear(Number(e.target.value))}/>
      </label>
    </div>
    <p className="text-xs text-amber-700">
      Hanya usulan untuk diperiksa HRD. Tidak menyalin tunjangan, BPJS, PPh21,
      atau kasbon historis. Tidak ada perubahan database, Draft, jurnal maupun pembayaran.
    </p>
    {loading&&<p role="status" className="text-sm">Memeriksa sumber Payroll lama...</p>}
    {error&&<p role="alert" className="text-sm text-muted-foreground">{error}</p>}
    {visible&&<>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4 text-sm">
        <div className="rounded border p-3">Karyawan aktif
          <strong className="block text-lg">{visible.summary.employeeCount}</strong></div>
        <div className="rounded border p-3">Kandidat perlu cek HRD
          <strong className="block text-lg">{visible.summary.candidatesNeedingHrConfirmation}</strong></div>
        <div className="rounded border p-3">Tanpa sumber
          <strong className="block text-lg">{visible.summary.noHistoricalSource}</strong></div>
        <div className="rounded border p-3">Kasbon lama perlu ditinjau
          <strong className="block text-lg">{visible.summary.historicalKasbonNeedsReview}</strong></div>
      </div>
      <div className="max-h-[430px] overflow-auto rounded border">
        <table className="w-full text-left text-xs md:text-sm">
          <thead className="sticky top-0 bg-background">
            <tr className="border-b">
              <th scope="col" className="p-2">Karyawan</th>
              <th scope="col" className="p-2">Sumber</th>
              <th scope="col" className="p-2">Usulan Gaji Pokok</th>
              <th scope="col" className="p-2">Status</th>
              <th scope="col" className="p-2">Tindakan</th>
            </tr>
          </thead>
          <tbody>
            {visible.rows.map(row=><tr className="border-b last:border-b-0" key={row.employeeId}>
              <td className="p-2">{row.employeeName} <span className="text-muted-foreground">#{row.employeeId}</span></td>
              <td className="p-2">{row.sourceRunId===null?"Tidak ada":
                `${String(row.sourceMonth).padStart(2,"0")}/${row.sourceYear} #${row.sourceRunId}`}</td>
              <td className="p-2 whitespace-nowrap">{row.proposedBaseSalary===null?"—":money(row.proposedBaseSalary)}</td>
              <td className="p-2">{row.status==="NEEDS_HR_CONFIRMATION"?
                "Cek HRD":row.status==="ALREADY_CONFIGURED"?
                "Sudah dikonfigurasi":row.status==="NO_HISTORICAL_SOURCE"?
                "Tidak ada sumber":"Sumber tidak valid"}
                {row.historicalKasbonNeedsReview&&<span className="block text-amber-700">Kasbon lama tidak disalin</span>}
              </td>
              <td className="p-2">
                {row.status==="NEEDS_HR_CONFIRMATION" && row.proposedBaseSalary!==null?
                  <Button size="sm" variant="outline" disabled={!canPrefill}
                    onClick={()=>onPrefill(row,year,month)}>Isi ke formulir</Button>:
                  <span className="text-muted-foreground">—</span>}
              </td>
            </tr>)}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        Tombol "Isi ke formulir" hanya mengisi usulan Gaji Pokok di layar, tidak menyimpan
        maupun menyetujui gaji. Semua komponen lain tetap membutuhkan pemeriksaan HRD.
      </p>
    </>}
  </section>;
}
