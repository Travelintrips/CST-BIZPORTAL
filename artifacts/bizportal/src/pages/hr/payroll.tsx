import React from "react";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { useCompany } from "@/contexts/CompanyContext";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AlertTriangle, Building2, Calculator, FileText, Loader2, RefreshCcw, Users } from "lucide-react";

type PayrollRun = {
  id: number;
  companyId: number | null;
  month: number;
  year: number;
  status: string;
  postingStatus?: string;
  integrityError?: string | null;
};
type PayrollItem = {
  item: {
    id: number;
    employeeId: number;
    baseSalary: string;
    allowance: string;
    grossSalary: string;
    kasbonDeduction: string;
    bpjsJhtEmployee: string;
    bpjsKesEmployee: string;
    pph21: string;
    otherDeductions: string;
    totalDeductions: string;
    netSalary: string;
  };
  employee: { firstName: string; lastName: string } | null;
};
type RunDetail = { run: PayrollRun; items: PayrollItem[]; integrityError?: string | null };
const money = (value: number | string) => new Intl.NumberFormat("id-ID", {
  style: "currency", currency: "IDR", maximumFractionDigits: 0,
}).format(Number(value || 0));

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init, credentials: "include", cache: "no-store",
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || payload.error || `HTTP ${response.status}`);
  return payload as T;
}

export default function PayrollWorkspace() {
  const { activeCompany, activeCompanyId, isConsolidated, isLoading: companyLoading } = useCompany();
  const companyId = !isConsolidated && Number.isSafeInteger(Number(activeCompanyId)) && Number(activeCompanyId) > 0
    ? Number(activeCompanyId) : null;
  const [runs, setRuns] = useState<PayrollRun[]>([]);
  const [canCreateDraft, setCanCreateDraft] = useState(false);
  const [canGenerate, setCanGenerate] = useState(false);
  const [canEditItems, setCanEditItems] = useState(false);
  const [editingItemId, setEditingItemId] = useState<number | null>(null);
  const [editValues, setEditValues] = useState<Record<string, string>>({});
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [month, setMonth] = useState(new Date().getMonth() + 1);
  const [year, setYear] = useState(new Date().getFullYear());
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const endpoint = companyId === null ? "" : `/api/payroll/runs?companyId=${companyId}`;
  const runUrl = (id: number, suffix = "") => `/api/payroll/runs/${id}${suffix}?companyId=${companyId}`;

  async function refresh(scopeCompanyId: number, id?: number | null) {
    const response = await api<{ runs: PayrollRun[] }>(`/api/payroll/runs?companyId=${scopeCompanyId}`);
    setRuns(response.runs.filter((r) => r.companyId === scopeCompanyId));
    if (id != null) {
      const chosen = response.runs.find((r) => r.id === id && r.companyId === scopeCompanyId);
      setDetail(chosen ? await api<RunDetail>(`/api/payroll/runs/${id}?companyId=${scopeCompanyId}`) : null);
    }
  }

  useEffect(() => {
    setRuns([]);
    setCanCreateDraft(false);
    setCanGenerate(false);
    setCanEditItems(false);
    setEditingItemId(null);
    setEditValues({});
    setSelectedId(null);
    setDetail(null);
    setError("");
    setNotice("");
    if (companyId == null) { setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    Promise.all([
      api<{ runs: PayrollRun[] }>(`/api/payroll/runs?companyId=${companyId}`),
      api<{ companyId: number; canCreateDraft: boolean; canGenerate: boolean; canEditItems: boolean }>(`/api/payroll/capabilities?companyId=${companyId}`),
    ])
      .then(([{ runs: result }, capabilities]) => {
        if (cancelled) return;
        setRuns(result.filter((r) => r.companyId === companyId));
        setCanCreateDraft(capabilities.companyId === companyId && capabilities.canCreateDraft === true);
        setCanGenerate(capabilities.companyId === companyId && capabilities.canGenerate === true);
        setCanEditItems(capabilities.companyId === companyId && capabilities.canEditItems === true);
      })
      .catch((e) => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [companyId]);

  useEffect(() => {
    if (companyId == null || selectedId == null) return;
    let cancelled = false;
    setDetail(null);
    api<RunDetail>(runUrl(selectedId))
      .then((result) => { if (!cancelled && result.run.companyId === companyId) setDetail(result); })
      .catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [companyId, selectedId]);

  async function perform(action: "create" | "generate" | "calculate") {
    if (companyId === null || busy) return;
    if (action !== "create" && (!selectedId || detail?.run.companyId !== companyId)) return;
    setBusy(true); setError(""); setNotice("");
    try {
      if (action === "create") {
        if (month < 1 || month > 12 || year < 2020 || year > 2100) throw new Error("Periode tidak valid.");
        const result = await api<{ run: PayrollRun }>(endpoint, {
          method: "POST", body: JSON.stringify({ month, year }),
        });
        if (result.run.companyId !== companyId) throw new Error("Perusahaan pada respons tidak sesuai.");
        setSelectedId(result.run.id);
        await refresh(companyId, result.run.id);
        setNotice("Periode payroll draft berhasil dibuat.");
      } else {
        const suffix = action === "generate" ? "/generate-items" : "/calculate";
        await api(runUrl(selectedId!, suffix), { method: "POST" });
        await refresh(companyId, selectedId);
        setNotice(action === "generate" ? "Karyawan aktif dimuat ke draft." : "Perhitungan payroll diperbarui.");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Operasi gagal.");
    } finally { setBusy(false); }
  }

  const draft = detail?.run.status === "draft";
  const editableFields = [
    ["baseSalary", "Gaji Pokok"], ["allowance", "Tunjangan"],
    ["bpjsJhtEmployee", "BPJS JHT"], ["bpjsKesEmployee", "BPJS Kesehatan"],
    ["pph21", "PPh21"], ["otherDeductions", "Potongan Lain"],
  ] as const;

  function beginEditing(item: PayrollItem["item"]) {
    const values: Record<string, string> = {};
    for (const [field] of editableFields) values[field] = String(item[field] ?? 0);
    setEditValues(values);
    setEditingItemId(item.id);
    setError("");
  }

  async function saveEditedItem(itemId: number) {
    if (busy || companyId == null || selectedId == null || !canEditItems ||
      detail?.run.companyId !== companyId || detail.run.status !== "draft") return;
    const updates: Record<string, number> = {};
    for (const [field, label] of editableFields) {
      const raw = editValues[field]?.trim() ?? "";
      if (!/^(?:0|[1-9][0-9]*)(?:\\.[0-9]{1,2})?$/.test(raw)) {
        setError(`Nilai ${label} tidak valid.`);
        return;
      }
      const value = Number(raw);
      if (!Number.isFinite(value) || value > 1_000_000_000_000) {
        setError(`Nilai ${label} melebihi batas.`);
        return;
      }
      updates[field] = value;
    }
    setBusy(true); setError(""); setNotice("");
    try {
      await api(runUrl(selectedId, `/items/${itemId}`), {
        method: "PATCH", body: JSON.stringify(updates),
      });
      await refresh(companyId, selectedId);
      setEditingItemId(null);
      setNotice("Komponen gaji Draft berhasil diperbarui.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Gagal memperbarui gaji.");
    } finally {
      setBusy(false);
    }
  }
  const totals = detail?.items.reduce((sum, { item }) => ({
    gross: sum.gross + Number(item.grossSalary || 0),
    advances: sum.advances + Number(item.kasbonDeduction || 0),
    net: sum.net + Number(item.netSalary || 0),
  }), { gross: 0, advances: 0, net: 0 }) ?? { gross: 0, advances: 0, net: 0 };

  return <AppShell>
    <div className="mx-auto max-w-7xl space-y-5 p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Gaji Karyawan</h1>
          <p className="text-sm text-muted-foreground">Payroll multi-company — riwayat dan rincian. Pembuatan draft hanya tersedia di DEV saat diizinkan server.</p>
        </div>
        <Button variant="outline" disabled={companyId == null || loading || busy} onClick={async () => {
          if (companyId === null) return;
          setLoading(true); setError("");
          try { await refresh(companyId, selectedId); } catch (e) { setError(e instanceof Error ? e.message : "Gagal memuat."); }
          finally { setLoading(false); }
        }}><RefreshCcw className="mr-2 h-4 w-4" />Refresh</Button>
      </div>

      {companyLoading ? <p>Memuat daftar perusahaan...</p> : companyId === null ?
        <div role="alert" className="rounded-lg border border-amber-500/40 p-4 text-sm">
          <Building2 className="mb-2 h-5 w-5" />
          Pilih satu perusahaan dari dropdown BizPortal. Mode Konsolidasi tidak dapat membuat, menghitung, atau membayar gaji.
        </div> :
        <div className="rounded-lg border px-4 py-3 text-sm">
          <Building2 className="mr-2 inline h-4 w-4" />
          Perusahaan: <strong>{activeCompany?.companyName}</strong> (ID {companyId})
        </div>}
      {error && <div role="alert" className="rounded-lg border border-red-500/40 p-3 text-sm text-red-500">{error}</div>}
      {notice && <div role="status" className="rounded-lg border p-3 text-sm">{notice}</div>}

      {companyId != null && <>
        <Card><CardHeader><CardTitle className="text-lg">Buat Periode Payroll</CardTitle></CardHeader>
          <CardContent className="flex flex-wrap items-end gap-3">
            <label className="text-sm">Bulan
              <select aria-label="Bulan payroll" className="mt-1 block rounded-md border bg-background p-2" value={month} onChange={(e) => setMonth(Number(e.target.value))}>
                {Array.from({ length: 12 }, (_, i) => <option key={i + 1} value={i + 1}>{new Intl.DateTimeFormat("id-ID", { month: "long" }).format(new Date(2026, i, 1))}</option>)}
              </select>
            </label>
            <label className="text-sm">Tahun
              <input aria-label="Tahun payroll" className="mt-1 block w-28 rounded-md border bg-background p-2" type="number" min="2020" max="2100" value={year} onChange={(e) => setYear(Number(e.target.value))} />
            </label>
            <Button disabled={!canCreateDraft || busy || loading || runs.some((run) => run.month === month && run.year === year)} onClick={() => perform("create")}>{canCreateDraft ? "Buat Draft DEV" : "Buat Draft (Belum Aktif)"}</Button>
          </CardContent>
        </Card>
        <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
          <Card><CardHeader><CardTitle className="text-lg">Riwayat Periode</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              {loading && <Loader2 className="h-5 w-5 animate-spin" />}
              {!loading && runs.length === 0 && <p className="text-sm text-muted-foreground">Belum ada periode.</p>}
              {runs.map((run) => <button key={run.id} type="button" onClick={() => setSelectedId(run.id)}
                className={`flex w-full items-center justify-between rounded-md border p-3 text-left text-sm ${run.id === selectedId ? "border-primary bg-primary/10" : "hover:bg-muted"}`}>
                <span>{String(run.month).padStart(2, "0")}/{run.year} <span className="text-muted-foreground">#{run.id}</span></span>
                <Badge variant="secondary">{run.status}</Badge>
              </button>)}
            </CardContent>
          </Card>
          <Card><CardHeader><CardTitle className="text-lg">Rincian Payroll</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              {!detail || detail.run.id !== selectedId ? <p className="text-sm text-muted-foreground">Pilih periode untuk melihat perhitungan.</p> : <>
                {detail.integrityError && <div role="alert" className="flex gap-2 rounded-md border border-red-500/40 p-3 text-sm text-red-500"><AlertTriangle className="h-4 w-4 shrink-0" />{detail.integrityError}</div>}
                <div className="flex flex-wrap gap-2">
                  <Badge>{detail.run.status}</Badge>
                  <Badge variant="outline">Posting: {detail.run.postingStatus || "pending"}</Badge>
                </div>
                <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                  {[[ "Karyawan", detail.items.length.toString() ], [ "Gaji Kotor", money(totals.gross) ], [ "Kasbon", money(totals.advances) ], [ "Gaji Bersih", money(totals.net) ]].map(([label, value]) =>
                    <div key={label} className="rounded-md border p-3"><p className="text-xs text-muted-foreground">{label}</p><p className="font-semibold">{value}</p></div>)}
                </div>
                {draft && <div className="flex flex-wrap gap-2">
                  <Button variant="outline" disabled={!canGenerate || busy} title={canGenerate ? "Muat karyawan aktif ke Draft DEV" : "Menunggu verifikasi backend DEV"} onClick={() => perform("generate")}><Users className="mr-2 h-4 w-4" />Muat Karyawan Aktif</Button>
                  <Button variant="outline" disabled title="Menunggu verifikasi alokasi kasbon" onClick={() => perform("calculate")}><Calculator className="mr-2 h-4 w-4" />Hitung Payroll</Button>
                </div>}
                <div className="overflow-x-auto"><table className="w-full text-left text-sm">
                  <thead><tr className="border-b"><th className="p-2">Karyawan</th><th className="p-2 text-right">Gaji Pokok</th><th className="p-2 text-right">Tunjangan</th><th className="p-2 text-right">Kasbon</th><th className="p-2 text-right">Bersih</th>{draft && canEditItems && <th className="p-2 text-right">Tindakan</th>}</tr></thead>
                  <tbody>{detail.items.map(({ item, employee }) =>
                    <React.Fragment key={item.id}><tr className="border-b"><td className="p-2">{employee ? `${employee.firstName} ${employee.lastName}` : `ID ${item.employeeId}`}</td>
                      <td className="p-2 text-right">{money(item.baseSalary)}</td><td className="p-2 text-right">{money(item.allowance)}</td>
                      <td className="p-2 text-right">{money(item.kasbonDeduction)}</td><td className="p-2 text-right font-medium">{money(item.netSalary)}</td>
                      {draft && canEditItems && <td className="p-2 text-right"><Button size="sm" variant="outline" disabled={busy} onClick={() => beginEditing(item)}>Edit</Button></td>}
                    </tr>
                    {draft && canEditItems && editingItemId === item.id && <tr className="border-b"><td colSpan={6} className="p-3">
                      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                        {editableFields.map(([field, label]) => <label key={field} className="text-xs">{label}
                          <input className="mt-1 block w-full rounded border bg-background p-2" type="number" min="0" max="1000000000000" step="0.01" value={editValues[field] ?? ""} onChange={(event) => setEditValues((previous) => ({ ...previous, [field]: event.target.value }))}/>
                        </label>)}
                      </div>
                      <div className="mt-3 flex gap-2"><Button size="sm" disabled={busy} onClick={() => saveEditedItem(item.id)}>Simpan Draft</Button>
                        <Button size="sm" variant="outline" disabled={busy} onClick={() => setEditingItemId(null)}>Batal</Button></div>
                    </td></tr>}</React.Fragment>)}</tbody>
                </table></div>
                <p className="flex items-center gap-2 text-xs text-muted-foreground"><FileText className="h-4 w-4" />Pembuatan Draft dan memuat karyawan hanya tersedia di DEV saat diizinkan server. Edit komponen hanya aktif di DEV. Perhitungan kasbon otomatis, persetujuan, pembayaran, dan slip gaji masih dinonaktifkan.</p>
              </>}
            </CardContent>
          </Card>
        </div>
      </>}
    </div>
  </AppShell>;
}
