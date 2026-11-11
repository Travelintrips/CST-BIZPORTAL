import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { AppShell } from "@/components/layout/AppShell";
import { useCompany } from "@/contexts/CompanyContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { ArrowLeft, Search, Users, RefreshCw } from "lucide-react";

type Employee = {
  id: number; company_id: number; first_name: string; last_name: string;
  status: string | null; email: string | null; phone: string | null;
  position: string | null; hire_date: string | null;
};
export default function HrdEmployeeDirectory() {
  const { activeCompanyId, isConsolidated } = useCompany();
  const companyId = !isConsolidated && Number.isSafeInteger(Number(activeCompanyId)) && Number(activeCompanyId) > 0
    ? Number(activeCompanyId) : null;
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const load = async () => {
    if (companyId === null) { setEmployees([]); setError("Pilih satu perusahaan untuk membuka data HRD."); return; }
    setLoading(true); setError("");
    try {
      const response = await fetch(`/api/hrd/employees?companyId=${companyId}`, {
        credentials: "include", cache: "no-store",
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.message || `HTTP ${response.status}`);
      if (body.companyId !== companyId || !Array.isArray(body.employees)) throw new Error("Scope perusahaan tidak cocok.");
      setEmployees(body.employees.filter((employee: Employee) => employee.company_id === companyId));
    } catch (cause) {
      setEmployees([]); setError(cause instanceof Error ? cause.message : "Data karyawan tidak dapat dimuat.");
    } finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, [companyId]);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? employees.filter((e) => [e.first_name,e.last_name,e.email,e.phone,e.position,String(e.id)]
      .some((v) => String(v ?? "").toLowerCase().includes(q))) : employees;
  }, [employees, search]);
  return <AppShell>
    <div className="mx-auto max-w-6xl space-y-6 p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-primary/10 p-3 text-primary"><Users className="h-6 w-6" /></div>
          <div><h1 className="text-2xl font-bold">Data Karyawan HRD</h1>
            <p className="text-sm text-muted-foreground">Direktori berdasarkan perusahaan aktif</p></div>
        </div>
        <Link href="/hr"><Button variant="outline"><ArrowLeft className="mr-2 h-4 w-4" />Kembali ke HR</Button></Link>
      </div>
      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="relative flex-1"><Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
          <Input className="pl-9" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Cari nama, ID, email, telepon, jabatan..." /></div>
        <Button variant="outline" onClick={() => void load()} disabled={loading}><RefreshCw className="mr-2 h-4 w-4" />Muat ulang</Button>
      </div>
      {error && <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">{error}</div>}
      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>{loading ? "Memuat data..." : `${filtered.length} karyawan`}</span><span>Perusahaan ID: {companyId ?? "Belum dipilih"}</span>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {filtered.map((employee) => <Card key={employee.id}>
          <CardContent className="flex items-start justify-between gap-4 p-4">
            <div className="min-w-0 space-y-1">
              <p className="font-semibold">{[employee.first_name,employee.last_name].filter(Boolean).join(" ") || "Tanpa nama"}</p>
              <p className="text-xs text-muted-foreground">ID {employee.id} · {employee.position || "Jabatan belum diisi"}</p>
              <p className="text-xs text-muted-foreground">{employee.email || employee.phone || "Kontak belum tersedia"}</p>
              <p className="text-xs text-muted-foreground">Status: {employee.status || "Tidak diketahui"}</p>
            </div>
            <Link href={`/hr/employees/${employee.id}`}><Button size="sm" variant="outline">Detail</Button></Link>
          </CardContent>
        </Card>)}
      </div>
      {!loading && !error && filtered.length === 0 && <div className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">Tidak ada karyawan yang cocok.</div>}
    </div>
  </AppShell>;
}
