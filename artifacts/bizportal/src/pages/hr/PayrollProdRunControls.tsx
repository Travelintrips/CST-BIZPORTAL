import {useEffect,useRef,useState} from "react";
import {Button} from "@/components/ui/button";

type EffectiveRow={
  employeeId:number;employeeName:string;salaryEffectiveFrom:string|null;
  baseSalary:string|null;allowance:string|null;gross:string|null;
  totalDeductions:string|null;net:string|null;
  deductions:Record<string,string|null>;issues:string[];missingDeductionCodes:string[];
};
type SetupPreview={
  companyId:number;runId:number;effectiveThrough:string;
  employeeCount:number;configuredCount:number;missingSalaryCount:number;
  missingDeductionConfigCount:number;invalidCount:number;
  gross:string;deductions:string;net:string;digest:string;rows:EffectiveRow[];
};
type ApprovalPreview={
  companyId:number;runId:number;status:string;canApprove:boolean;
  blockedReasons:string[];itemCount:number;gross:string;deductions:string;
  net:string;digest:string;fullCoverage:boolean;kasbonReservationVerified:boolean;
};
type Props={
  companyId:number;runId:number;status:string;
  canViewSetup:boolean;canApplySetup:boolean;canApproveSuperAdmin:boolean;
  onChanged:()=>Promise<void>;
};
const currency=(s:string)=>new Intl.NumberFormat("id-ID",{
  style:"currency",currency:"IDR",maximumFractionDigits:2,
}).format(Number(s));
async function request<T>(url:string,options:RequestInit={}):Promise<T>{
  const response=await fetch(url,{
    ...options,credentials:"include",cache:"no-store",
    headers:{"Content-Type":"application/json",...options.headers},
  });
  const payload=await response.json().catch(()=>({}));
  if(!response.ok)throw Error(payload.message??"Permintaan Payroll tidak dapat diselesaikan.");
  return payload as T;
}
/** Small opt-in extension of the existing PROD Payroll page. Never posts a
 * bank payment, journal, cash advance settlement or HR/accounting approval.
 */
export function PayrollProdRunControls({
  companyId,runId,status,canViewSetup,canApplySetup,canApproveSuperAdmin,onChanged,
}:Props){
  const scope=companyId+":"+runId;
  const current=useRef(scope);
  current.current=scope;
  const [setup,setSetup]=useState<SetupPreview|null>(null);
  const [approval,setApproval]=useState<ApprovalPreview|null>(null);
  const [approvalNote,setApprovalNote]=useState("");
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [message,setMessage]=useState("");
  useEffect(()=>{
    setSetup(null);setApproval(null);setApprovalNote("");
    setBusy(false);setError("");setMessage("");
  },[scope]);
  const draft=status==="draft";
  if(!canViewSetup&&!canApproveSuperAdmin)return null;
  const matches=(o:{companyId:number;runId:number})=>
    o.companyId===companyId&&o.runId===runId&&current.current===scope;
  const url=(suffix:string)=>"/api/payroll/runs/"+runId+"/"+suffix+"?companyId="+companyId;

  async function loadSetup(){
    if(!draft||!canViewSetup||busy)return;
    setBusy(true);setError("");setMessage("");setSetup(null);
    try{
      const data=await request<SetupPreview>(url("setup-preview"));
      if(!matches(data))return;
      setSetup(data);
    }catch(e){if(current.current===scope)setError(e instanceof Error?e.message:"Pratinjau gaji gagal.");}
    finally{if(current.current===scope)setBusy(false);}
  }
  const ready=setup!==null&&matches(setup)&&setup.employeeCount>0&&
    setup.missingSalaryCount===0&&setup.missingDeductionConfigCount===0&&setup.invalidCount===0&&
    setup.rows.every(r=>r.net!==null&&r.deductions.kasbon_deduction!==null);
  async function applySetup(){
    if(!draft||!canApplySetup||!ready||busy||!setup)return;
    if(!window.confirm("Terapkan struktur gaji dan reservasi kasbon terverifikasi ke item Draft yang BELUM ada? Tidak membuat jurnal atau pembayaran."))return;
    setBusy(true);setError("");setMessage("");
    try{
      const saved=await request<{companyId:number;runId:number;added:number;skipped:number;readyForPayment:false}>(
        url("apply-setup"),{method:"POST",body:JSON.stringify({confirm:true,expectedDigest:setup.digest})});
      if(!matches(saved))return;
      setSetup(null);setApproval(null);
      await onChanged();
      if(current.current===scope)setMessage(saved.added+" item baru disiapkan; "+saved.skipped+
        " item yang sudah ada tidak diubah. Belum ada pembayaran/jurnal.");
    }catch(e){if(current.current===scope)setError(e instanceof Error?e.message:"Penerapan Draft gagal.");}
    finally{if(current.current===scope)setBusy(false);}
  }
  async function loadApproval(){
    if(!draft||!canApproveSuperAdmin||busy)return;
    setBusy(true);setError("");setMessage("");setApproval(null);
    try{
      const data=await request<ApprovalPreview>(url("super-admin-approval-preview"));
      if(matches(data))setApproval(data);
    }catch(e){if(current.current===scope)setError(e instanceof Error?e.message:"Pratinjau persetujuan gagal.");}
    finally{if(current.current===scope)setBusy(false);}
  }
  async function approve(){
    if(!draft||!canApproveSuperAdmin||!approval||!matches(approval)||
      !approval.canApprove||approvalNote.trim().length<10||approvalNote.length>500||busy)return;
    if(!window.confirm("Setujui Payroll satu kali sebagai Super Admin dan kunci Draft? Tidak membuat jurnal atau membayar gaji."))return;
    setBusy(true);setError("");setMessage("");
    try{
      const result=await request<{companyId:number;runId:number;status:string;oneSuperAdminApproval:boolean;
        readyForPayment:false;paid:false;accountingPosted:false}>(url("super-admin-approve"),{
          method:"POST",body:JSON.stringify({
            confirm:true,expectedDigest:approval.digest,note:approvalNote.trim(),
          }),
        });
      if(!matches(result)||!result.oneSuperAdminApproval||result.status!=="reviewed"||
        result.readyForPayment!==false||result.paid!==false||result.accountingPosted!==false)
        throw Error("Bukti persetujuan Super Admin tidak cocok.");
      setApproval(null);setSetup(null);
      await onChanged();
      if(current.current===scope)setMessage("Persetujuan Super Admin tercatat. Draft terkunci; belum ada jurnal atau pembayaran.");
    }catch(e){if(current.current===scope)setError(e instanceof Error?e.message:"Persetujuan gagal.");}
    finally{if(current.current===scope)setBusy(false);}
  }
  return <section className="space-y-3 rounded-lg border p-3 text-sm"
    aria-label="Pratinjau dan persetujuan Payroll otomatis">
    <div>
      <p className="font-semibold">Payroll Penuh/Cicilan — Super Admin</p>
      <p className="text-xs text-muted-foreground">
        Struktur gaji mengikuti tanggal berlaku. Kasbon otomatis hanya boleh berasal dari
        sumber disetujui, dicairkan dan jurnal yang tercatat. Tidak melakukan pembayaran.
      </p>
    </div>
    {error&&<p role="alert" className="text-sm text-red-600">{error}</p>}
    {message&&<p role="status" className="text-sm">{message}</p>}
    {draft ? <>
      {canViewSetup&&<>
        <Button variant="outline" disabled={busy} onClick={()=>void loadSetup()}>
          {busy?"Memeriksa...":"Pratinjau Struktur Gaji & Kasbon"}
        </Button>
        {setup&&matches(setup)&&<>
          <p role="status" className="text-xs">Berlaku hingga {setup.effectiveThrough} ·
            {setup.configuredCount}/{setup.employeeCount} karyawan lengkap
          </p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <div>Kotor <strong className="block">{currency(setup.gross)}</strong></div>
            <div>Potongan <strong className="block">{currency(setup.deductions)}</strong></div>
            <div>Bersih <strong className="block">{currency(setup.net)}</strong></div>
          </div>
          <div className="max-h-64 overflow-x-auto overflow-y-auto">
            <table className="w-full text-left text-xs">
              <thead><tr className="border-b"><th className="p-2">Karyawan</th>
                <th className="p-2 text-right">Kotor</th>
                <th className="p-2 text-right">Kasbon</th>
                <th className="p-2 text-right">Bersih</th>
                <th className="p-2">Validasi</th></tr></thead>
              <tbody>{setup.rows.map(r=><tr key={r.employeeId} className="border-b">
                <td className="p-2">{r.employeeName}</td>
                <td className="p-2 text-right">{r.gross===null?"—":currency(r.gross)}</td>
                <td className="p-2 text-right">{r.deductions.kasbon_deduction===null?"—":currency(r.deductions.kasbon_deduction)}</td>
                <td className="p-2 text-right">{r.net===null?"—":currency(r.net)}</td>
                <td className="p-2">{r.issues.length?r.issues.join(", ").replaceAll("_"," "):"Siap"}
                  {r.missingDeductionCodes?.length>0&&<span className="block text-amber-600">
                    Belum diisi: {r.missingDeductionCodes.join(", ").replaceAll("_"," ")}</span>}</td>
              </tr>)}</tbody>
            </table>
          </div>
          <Button disabled={!canApplySetup||!ready||busy} onClick={()=>void applySetup()}>
            Terapkan ke Draft (Hanya Item Baru)
          </Button>
          {!canApplySetup&&<p className="text-xs text-muted-foreground">Penerapan belum diaktifkan untuk PROD.</p>}
          {!ready&&<p role="alert" className="text-xs text-amber-700">
            Gaji atau potongan belum lengkap, atau kasbon belum memiliki sumber/reservasi yang sah.
          </p>}
        </>}
      </>}
      {canApproveSuperAdmin&&<>
        <Button variant="outline" disabled={busy} onClick={()=>void loadApproval()}>
          Periksa Sebelum Disetujui
        </Button>
        {approval&&matches(approval)&&<>
          <p role="status" className="text-xs">
            {approval.itemCount} karyawan · Kotor {currency(approval.gross)} ·
            Potongan {currency(approval.deductions)} · Bersih {currency(approval.net)}
          </p>
          {approval.blockedReasons.length>0&&<p role="alert" className="text-xs text-red-600">
            Belum dapat disetujui: {approval.blockedReasons.join(", ").replaceAll("_"," ")}.
          </p>}
          <label className="block text-xs">Catatan Super Admin (10–500 karakter)
            <textarea aria-label="Catatan Persetujuan Super Admin Payroll PROD"
              className="mt-1 w-full rounded border bg-background p-2 text-sm"
              maxLength={500} rows={2} value={approvalNote}
              onChange={e=>setApprovalNote(e.target.value)}/>
          </label>
          <Button disabled={busy||!approval.canApprove||approvalNote.trim().length<10}
            onClick={()=>void approve()}>Setujui Satu Kali & Kunci Draft</Button>
        </>}
      </>}
    </> : <p className="text-xs text-muted-foreground">
      {status==="reviewed"?"Draft sudah ditinjau dan terkunci. Persetujuan tidak dapat diulang.":
      "Hanya Draft bersih yang dapat disiapkan dan disetujui. Tidak ada perubahan data."}
    </p>}
  </section>;
}
