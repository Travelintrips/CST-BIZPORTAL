import { useEffect,useRef,useState } from "react";
import { Button } from "@/components/ui/button";

type Choice="FULL"|"INSTALLMENT";
type Advance={
  advanceId:number;
  choice:Choice|null;
  installmentAmount:string|null;
  firstPeriod:string|null;
  planLocked?:boolean;
  status:string;
  lifecycleStatus:string|null;
  remainingAmount:string;
  planNotes:string;
};
type ProjectionRow={
  advanceId:number;choice:Choice|null;balance:string;
  proposed:string|null;issue:string|null;existingPreparation:boolean;
};
type Projection={
  companyId:number;employeeId:number;year:number;month:number;canEdit:boolean;
  advances:Advance[];
  preview:{
    rows:ProjectionRow[];total:string|null;canApply:boolean;
    canSettle:false;canPay:false;canPost:false;
  };
  persistedDeduction:false;settledCashAdvance:false;
};
type Draft={choice:Choice|"";installmentAmount:string;notes:string};
const money=/^(0|[1-9][0-9]{0,12})(?:\.([0-9]{1,2}))?$/;
function currency(raw:string){
  return new Intl.NumberFormat("id-ID",{style:"currency",currency:"IDR",maximumFractionDigits:2}).format(Number(raw));
}
async function send<T>(url:string,opts:RequestInit={}):Promise<T>{
  const r=await fetch(url,{credentials:"include",cache:"no-store",
    headers:{"Content-Type":"application/json"},...opts});
  const data=await r.json().catch(()=>({}));
  if(!r.ok)throw Error(data.message??"Pengaturan kasbon belum tersedia.");
  return data as T;
}
export function PayrollKasbonAutoPlanPanel({
  companyId,employeeId,effectiveFrom,onCalculated,
}:{
  companyId:number;employeeId:number;effectiveFrom:string;
  onCalculated:(amount:string)=>void;
}){
  const [data,setData]=useState<Projection|null>(null);
  const [drafts,setDrafts]=useState<Record<number,Draft>>({});
  const [loading,setLoading]=useState(false);
  const [busy,setBusy]=useState<number|null>(null);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const callback=useRef(onCalculated);
  callback.current=onCalculated;
  const period=/^20\d\d-(0[1-9]|1[0-2])/.test(effectiveFrom)?
    effectiveFrom.slice(0,7)+"-01":null;
  const year=period?Number(period.slice(0,4)):null;
  const month=period?Number(period.slice(5,7)):null;
  async function refresh(){
    if(!period||year===null||month===null)return;
    const result=await send<Projection>(
      `/api/payroll/kasbon/employee/${employeeId}?companyId=${companyId}&year=${year}&month=${month}`);
    if(result.companyId!==companyId||result.employeeId!==employeeId||
       result.year!==year||result.month!==month)throw Error("Respons kasbon bukan milik periode/karyawan ini.");
    setData(result);
    setDrafts(Object.fromEntries(result.advances.map(a=>[a.advanceId,{
      choice:a.choice??"",installmentAmount:a.installmentAmount??"",
      notes:a.planNotes??"",
    }])));
    if(result.preview.canApply&&result.preview.total!==null&&result.preview.rows.length>0)
      callback.current(result.preview.total);
  }
  useEffect(()=>{
    let active=true;
    setData(null);setError("");setNotice("");setDrafts({});
    if(!period)return()=>{active=false};
    setLoading(true);
    const url=`/api/payroll/kasbon/employee/${employeeId}?companyId=${companyId}&year=${year}&month=${month}`;
    send<Projection>(url).then(d=>{
      if(!active)return;
      if(d.companyId!==companyId||d.employeeId!==employeeId||d.year!==year||d.month!==month)
        throw Error("Respons kasbon tidak sesuai karyawan/perusahaan.");
      setData(d);
      setDrafts(Object.fromEntries(d.advances.map(a=>[a.advanceId,{
        choice:a.choice??"",installmentAmount:a.installmentAmount??"",notes:a.planNotes??"",
      }])));
      if(d.preview.canApply&&d.preview.total!==null&&d.preview.rows.length>0)
        callback.current(d.preview.total);
    }).catch(e=>{if(active)setError(e instanceof Error?e.message:"Pratinjau kasbon tidak tersedia.")})
      .finally(()=>{if(active)setLoading(false)});
    return()=>{active=false};
  },[companyId,employeeId,period,year,month]);
  function change(id:number,v:Partial<Draft>){
    setDrafts(prev=>{
      const current=prev[id]??{choice:"" as const,installmentAmount:"",notes:""};
      return {...prev,[id]:{...current,...v}};
    });
    setNotice("");
  }
  async function saveChoice(a:Advance){
    const d=drafts[a.advanceId];
    if(!period||!d||!d.choice||d.notes.trim().length<5||
       (d.choice==="INSTALLMENT"&&(!money.test(d.installmentAmount)||Number(d.installmentAmount)<=0))){
      setError("Pilih Penuh/Cicilan, nominal cicilan yang benar, dan catatan keputusan Super Admin.");return;
    }
    if(!window.confirm(`Simpan pola potongan ${d.choice==="FULL"?"Penuh":"Cicilan"} untuk kasbon #${a.advanceId}? Saldo kasbon tidak berkurang sampai pembayaran gaji dan settlement kasbon terverifikasi.`))return;
    setBusy(a.advanceId);setError("");setNotice("");
    try {
      const r=await send<{advanceId:number;choice:Choice;estimatedCurrentDeduction:string}>(
        `/api/payroll/kasbon/plans/${a.advanceId}?companyId=${companyId}`,{
          method:"PUT",body:JSON.stringify({
            employeeId,choice:d.choice,
            installmentAmount:d.choice==="FULL"?null:d.installmentAmount,
            firstPeriod:period,notes:d.notes.trim(),
          }),
        });
      if(r.advanceId!==a.advanceId||r.choice!==d.choice)throw Error("Respons penyimpanan pilihan kasbon salah.");
      await refresh();
      setNotice("Pola potongan kasbon tersimpan. Nominal periode ini dihitung otomatis; saldo belum dilunasi.");
    }catch(e){setError(e instanceof Error?e.message:"Pola kasbon belum tersimpan.")}
    finally{setBusy(null)}
  }
  return <section className="space-y-3 rounded-lg border p-3" aria-label="Kasbon otomatis penuh atau cicilan">
    <div>
      <h3 className="font-semibold">Potongan Kasbon Otomatis</h3>
      <p className="text-xs text-muted-foreground">Pilih sekali: <strong>Penuh</strong> (sisa kasbon) atau <strong>Cicilan</strong> (nominal per bulan).
        Angka diambil dari saldo kasbon karyawan BizPortal, bukan Rekonsiliasi Bank.
        Potongan disiapkan untuk Draft; saldo kasbon tidak berkurang sampai pembayaran/settlement yang sah diverifikasi.</p>
    </div>
    {loading&&<p className="text-sm">Membaca kasbon karyawan...</p>}
    {error&&<p role="alert" className="text-sm text-red-600">{error}</p>}
    {notice&&<p role="status" className="text-sm">{notice}</p>}
    {!loading&&data?.advances.length===0&&<p className="text-sm text-muted-foreground">Belum ada kasbon karyawan yang tercatat. Tidak ada potongan otomatis.</p>}
    {data&&!data.canEdit&&<p className="text-xs text-muted-foreground">Pengaturan Penuh/Cicilan hanya dapat disimpan oleh Super Admin setelah koneksi Payroll khusus dan feature flag diaktifkan.</p>}
    {data?.advances.map(a=>{
      const d=drafts[a.advanceId]??{choice:"",installmentAmount:"",notes:""};
      const result=data.preview.rows.find(x=>x.advanceId===a.advanceId);
      const canConfigure=Boolean(result)&&!a.planLocked&&!result!.existingPreparation&&
        (result!.issue===null||result!.issue==="PILIH_PENUH_ATAU_CICILAN");
      return <div key={a.advanceId} className="space-y-2 rounded border p-3">
        <div className="text-sm font-medium">Kasbon #{a.advanceId} — Sisa {currency(a.remainingAmount)}</div>
        <div className="text-xs text-muted-foreground">Status: {a.status}/{a.lifecycleStatus??"-"}.</div>
        {!canConfigure&&<p className="text-xs text-muted-foreground">
          {a.planLocked
            ?"Rencana Penuh/Cicilan sudah digunakan pada Draft dan dikunci agar riwayat potongan tidak berubah."
            :result?.issue==="KASBON_PLAN_SOURCE_NOT_ELIGIBLE"
            ?"Rencana dikunci: sumber kasbon tidak lagi memenuhi syarat persetujuan, pencairan, atau jurnal."
            :result?.existingPreparation
              ?"Kasbon sudah disiapkan dalam Draft; pilihan tidak dapat diubah sampai proses penyelesaian selesai."
              :result?.issue
                ?result.issue.replaceAll("_"," ")
                :"Belum memenuhi syarat untuk dipotong otomatis (belum dicairkan, lunas, atau status tidak aktif)."}
        </p>}
        {canConfigure&&<div className="grid gap-2 sm:grid-cols-2">
          <label className="text-sm">Metode Potongan
            <select aria-label={`Metode potongan kasbon ${a.advanceId}`}
              className="mt-1 w-full rounded border bg-background p-2" value={d.choice}
              disabled={!data?.canEdit||busy!==null} onChange={e=>change(a.advanceId,{choice:e.target.value as Choice|""})}>
              <option value="">Pilih Penuh atau Cicilan...</option>
              <option value="FULL">Potong Penuh (sisa kasbon)</option>
              <option value="INSTALLMENT">Cicilan per Bulan</option>
            </select>
          </label>
          {d.choice==="INSTALLMENT"&&<label className="text-sm">Nominal Cicilan Bulanan
            <input aria-label={`Nominal cicilan kasbon ${a.advanceId}`}
              className="mt-1 w-full rounded border bg-background p-2" inputMode="decimal"
              placeholder="Contoh 500000" value={d.installmentAmount} disabled={!data?.canEdit||busy!==null}
              onChange={e=>change(a.advanceId,{installmentAmount:e.target.value.trim()})}/>
          </label>}
          <label className="text-sm sm:col-span-2">Catatan keputusan Super Admin
            <input aria-label={`Persetujuan kasbon ${a.advanceId}`}
              className="mt-1 w-full rounded border bg-background p-2" maxLength={500}
              placeholder="Contoh: Potong Rp500.000/bulan mulai November sesuai persetujuan"
              value={d.notes} disabled={!data?.canEdit||busy!==null}
              onChange={e=>change(a.advanceId,{notes:e.target.value})}/>
          </label>
          <Button variant="outline" disabled={!data?.canEdit||busy!==null||!d.choice||d.notes.trim().length<5||
            (d.choice==="INSTALLMENT"&&(!money.test(d.installmentAmount)||Number(d.installmentAmount)<=0))}
            onClick={()=>void saveChoice(a)}>
            {busy===a.advanceId?"Menyimpan...":"Simpan Pilihan Kasbon"}
          </Button>
          <p className="text-xs text-muted-foreground">Potongan bulan ini: {result?.proposed!==null&&result?.proposed!==undefined?
            currency(result.proposed):result?.issue??"Pilih dan simpan dahulu"}</p>
        </div>}
      </div>;
    })}
    {data?.preview.canApply&&data.preview.total!==null&&
      <p className="text-sm font-medium">Total kasbon otomatis periode {period}: {currency(data.preview.total)}.
        <span className="block text-xs font-normal text-muted-foreground">Nilai ini otomatis diisi ke kolom Potongan Kasbon pada formulir gaji. Belum dipotong dari saldo kasbon.</span>
      </p>}
    {data?.preview.total===null&&
      <p className="text-sm text-red-600">Potongan otomatis belum siap: ada kasbon tanpa pilihan atau potongan periode sebelumnya belum diverifikasi.</p>}
  </section>;
}
