import { DatePicker } from "@/components/ui/date-picker";
import { useState, useEffect } from "react";
import { Link, useLocation, useParams, useSearch } from "wouter";
import { AppShell } from "@/components/layout/AppShell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCompany } from "@/contexts/CompanyContext";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Plus, Trash2, Eye, ChevronLeft, ChevronRight, Send, CheckCircle, FileText, Bot, Banknote, RotateCcw, RefreshCw, Wrench, Split } from "lucide-react";
import { toast } from "sonner";
import {
  canonicalAmountPaid,
  canonicalGrandTotal,
  canonicalWithholdingAmount,
  formatPaymentMutationError,
  hasPaymentResetBlockers,
  outstandingNetPayment,
  vendorInvoicePaymentSummary,
} from "@/lib/vendorInvoicePayment";

const idr = (n: number | string | null | undefined) => {
  const amount = Number(n);
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 })
    .format(Number.isFinite(amount) ? amount : 0);
};
const apiFetch = (path: string, opts?: RequestInit) => fetch(`/api${path}`, { credentials: "include", headers: { "Content-Type": "application/json" }, ...opts });
const VENDOR_INVOICE_REQUEST_TIMEOUT_MS = 15_000;
const vendorInvoiceFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), VENDOR_INVOICE_REQUEST_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("Server tidak merespons. Silakan coba lagi.");
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
};
const formatPostingError = (body: unknown, fallback: string) => {
  return formatPaymentMutationError(body, fallback);
};

interface VILine { id?: number; productId?: number; name: string; quantity: string; unit: string; unitCost: string; subtotal: string; taxAmount: string; coaAccountId?: string; taxType?: string; taxObject?: string; withholdingAmount?: string; liabilityAccountId?: string; notes: string; }
interface VIInvoiceBreakdownComponent {
  withholding_tax_type?: string | null;
  withholding_tax_amount?: number | null;
}
interface VI {
  id: number;
  invoiceNumber: string;
  status: string;
  supplierName: string;
  vendorInvoiceRef?: string;
  poId?: number;
  grId?: number;
  invoiceDate: string;
  dueDate?: string;
  paymentTermDays: number;
  totalAmount: string;
  taxAmount: string;
  grandTotal: string;
  grand_total?: string | number | null;
  reconciledAmountPaid?: string | number | null;
  amountPaid?: string | number | null;
  amount_paid?: string | number | null;
  journalStatus?: string | null;
  journalEntryNumber?: string | null;
  withholdingTaxAmount?: string | number | null;
  withholding_tax_amount?: string | number | null;
  invoiceBreakdown?: {
    components?: VIInvoiceBreakdownComponent[];
    totals?: {
      withholding_tax_amount?: string | number | null;
      payable_amount?: string | number | null;
    } | null;
  } | null;
  threeWayMatchStatus: string;
  matchNotes?: string;
  lines: VILine[];
  lineTaxes?: Array<{
    id?: number;
    invoiceLineId: number;
    taxType: string;
    taxObject: string;
    taxAmount: string;
    liabilityAccountId?: number | null;
    resolutionStatus?: string | null;
  }>;
  withholdingRecords?: Array<{ lineTaxId?: number; invoiceLineId?: number; status?: string | null }>;
}
interface LiabilityAccount { id: number; code: string; name: string; }
interface LegacyRepairQueueItem {
  id: number;
  invoiceNumber: string;
  supplierName: string | null;
  status: string;
  grandTotal: number;
  withholdingAmount: number;
  reasonCode: string;
  reason: string;
  componentCount: number;
}
interface LegacyRepairPreview {
  repairRequired: boolean;
  invoiceId: number;
  invoiceNumber?: string;
  supplierName?: string | null;
  grandTotal?: number;
  reason?: string;
  rows: Array<{
    invoiceLineId: number;
    taxType: string;
    taxObject: string;
    baseAmount: number;
    taxAmount: number;
    liabilityAccountId: number | null;
  }>;
}
interface LegacyRepairAuditRow {
  invoiceLineId: number | null;
  taxType: string;
  taxObject: string;
  baseAmount: number;
  taxAmount: number;
  liabilityAccountId: number | null;
  lineTaxId: number | null;
  resolutionStatus: string | null;
}
interface LegacyRepairAuditEvent {
  id: number;
  actor: string | null;
  timestamp: string;
  reason: string;
  beforeRows: LegacyRepairAuditRow[];
  afterRows: LegacyRepairAuditRow[];
}
type VendorInvoiceListItem = Record<string, unknown>;
interface VendorInvoicePage {
  data: VendorInvoiceListItem[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
}


function vendorInvoiceWithholdingLabel(invoice: Record<string, unknown>): string {
  const labels = new Set<string>();
  const directType = String(invoice.withholdingTaxType ?? "").trim();
  if (directType) labels.add(directType);

  const breakdown = invoice.invoiceBreakdown && typeof invoice.invoiceBreakdown === "object"
    ? invoice.invoiceBreakdown as Record<string, unknown>
    : null;
  const components = Array.isArray(breakdown?.components) ? breakdown.components : [];
  for (const componentValue of components) {
    if (!componentValue || typeof componentValue !== "object") continue;
    const component = componentValue as Record<string, unknown>;
    const label = String(component.withholding_tax_type ?? component.tax_type ?? "").trim();
    if (label) labels.add(label);
  }

  return Array.from(labels).join(", ");
}

function parseVendorInvoicePage(payload: unknown): VendorInvoicePage {
  if (Array.isArray(payload)) {
    const data = payload as VendorInvoiceListItem[];
    return { data, page: 1, pageSize: data.length, total: data.length, hasMore: false };
  }
  if (payload && typeof payload === "object") {
    const data = (payload as { data?: unknown }).data;
    if (Array.isArray(data)) {
      const response = payload as Partial<VendorInvoicePage>;
      return {
        data: data as VendorInvoiceListItem[],
        page: Number(response.page) || 1,
        pageSize: Number(response.pageSize) || data.length,
        total: Number(response.total) || data.length,
        hasMore: response.hasMore === true,
      };
    }
  }
  throw new Error("Format data vendor invoice dari server tidak valid.");
}

export function VendorInvoicesListPage() {
  const { activeCompanyId, isLoading: isCompanyLoading, refetch: refetchCompanies } = useCompany();
  const qcClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [postingId, setPostingId] = useState<number | null>(null);
  const [recoveringId, setRecoveringId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [repairInvoiceId, setRepairInvoiceId] = useState<number | null>(null);
  const [repairReason, setRepairReason] = useState("");
  const [repairRows, setRepairRows] = useState<LegacyRepairPreview["rows"]>([]);
  const [repairKey, setRepairKey] = useState("");
  const pageSize = 50;

  const { data: invoicePage, isLoading, isFetching, isError, error } = useQuery<VendorInvoicePage>({
    queryKey: ["/api/purchase-workflow/vendor-invoices", activeCompanyId, page],
    queryFn: async () => {
      const response = await vendorInvoiceFetch(`/api/purchase-workflow/vendor-invoices?company=${activeCompanyId}&page=${page}&pageSize=${pageSize}`, {
        credentials: "include",
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const message = payload && typeof payload === "object"
          ? String((payload as { error?: unknown; message?: unknown }).error
            ?? (payload as { message?: unknown }).message
            ?? "Gagal memuat vendor invoice.")
          : "Gagal memuat vendor invoice.";
        throw new Error(message);
      }
      return parseVendorInvoicePage(payload);
    },
    enabled: activeCompanyId != null,
  });
  const vis = invoicePage?.data ?? [];
  const { data: repairQueue = [], isLoading: repairQueueLoading } = useQuery<LegacyRepairQueueItem[]>({
    queryKey: ["/api/purchase-workflow/vendor-invoices/legacy-withholding-repairs", activeCompanyId],
    queryFn: async () => {
      const response = await vendorInvoiceFetch(
        `/api/purchase-workflow/vendor-invoices/legacy-withholding-repairs?company=${activeCompanyId}`,
        { credentials: "include" },
      );
      const payload = await response.json().catch(() => null) as { data?: unknown } | null;
      if (!response.ok || !Array.isArray(payload?.data)) {
        throw new Error("Daftar perbaikan PPh gagal dimuat.");
      }
      return payload.data as LegacyRepairQueueItem[];
    },
    enabled: activeCompanyId != null,
  });
  const { data: repairPreview, isLoading: repairPreviewLoading } = useQuery<LegacyRepairPreview>({
    queryKey: ["/api/purchase-workflow/vendor-invoices/legacy-withholding-repair", repairInvoiceId, activeCompanyId],
    queryFn: async () => {
      const response = await apiFetch(
        `/purchase-workflow/vendor-invoices/${repairInvoiceId}/legacy-withholding-repair?company=${activeCompanyId}`,
      );
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(formatPostingError(payload, "Preview perbaikan PPh gagal dimuat."));
      return payload as LegacyRepairPreview;
    },
    enabled: repairInvoiceId != null && activeCompanyId != null,
  });
  const { data: repairAccounts = [] } = useQuery<LiabilityAccount[]>({
    queryKey: ["/api/purchase-workflow/vendor-invoices/liability-accounts", activeCompanyId],
    queryFn: async () => {
      const response = await apiFetch(`/purchase-workflow/vendor-invoices/liability-accounts?company=${activeCompanyId}`);
      const payload = await response.json().catch(() => null);
      if (!response.ok || !Array.isArray(payload)) throw new Error("Akun liabilitas gagal dimuat.");
      return payload as LiabilityAccount[];
    },
    enabled: repairInvoiceId != null && activeCompanyId != null,
  });
  const totalPages = Math.max(1, Math.ceil((invoicePage?.total ?? 0) / pageSize));

  useEffect(() => {
    setPage(1);
  }, [activeCompanyId]);

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  useEffect(() => {
    if (!repairPreview?.repairRequired) return;
    setRepairRows(repairPreview.rows.map((row) => ({
      ...row,
      taxType: /\s+\+\s+/.test(row.taxType) ? "" : row.taxType,
      taxObject: row.taxObject === "legacy_invoice_header" ? "" : row.taxObject,
    })));
    setRepairReason("");
    setRepairKey(crypto.randomUUID());
  }, [repairPreview]);

  const repairMut = useMutation({
    mutationFn: async () => {
      const response = await apiFetch(
        `/purchase-workflow/vendor-invoices/${repairInvoiceId}/legacy-withholding-repair?company=${activeCompanyId}`,
        {
          method: "POST",
          body: JSON.stringify({ reason: repairReason, idempotencyKey: repairKey, rows: repairRows }),
        },
      );
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(formatPostingError(payload, "Perbaikan PPh gagal disimpan."));
      return payload;
    },
    onSuccess: async () => {
      toast.success("Rincian PPh berhasil diperbaiki dan diaudit");
      setRepairInvoiceId(null);
      await Promise.all([
        qcClient.invalidateQueries({ queryKey: ["/api/purchase-workflow/vendor-invoices/legacy-withholding-repairs", activeCompanyId] }),
        qcClient.invalidateQueries({ queryKey: ["/api/purchase-workflow/vendor-invoices", activeCompanyId] }),
      ]);
    },
    onError: (repairError) => toast.error(repairError instanceof Error ? repairError.message : "Perbaikan PPh gagal."),
  });

  const handlePost = async (id: number) => {
    setPostingId(id);
    try {
      const r = await apiFetch(`/purchase-workflow/vendor-invoices/${id}/post?company=${activeCompanyId}`, { method: "POST" });
      if (!r.ok) {
        const errJson = await r.json().catch(() => ({}));
        throw new Error(formatPostingError(errJson, "Gagal posting invoice"));
      }
      toast.success("Invoice berhasil diposting");
      qcClient.invalidateQueries({ queryKey: ["/api/purchase-workflow/vendor-invoices", activeCompanyId] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Gagal posting invoice");
    } finally {
      setPostingId(null);
    }
  };

  const handleRecover = async (id: number) => {
    if (!window.confirm("Promosikan journal draft yang tertaut menjadi posted? Journal lain/orphan tidak akan diubah.")) {
      return;
    }
    setRecoveringId(id);
    try {
      const r = await apiFetch(`/purchase-workflow/vendor-invoices/${id}/recover-journal?company=${activeCompanyId}`, { method: "POST" });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(formatPostingError(body, "Gagal memulihkan jurnal"));
      toast.success("Journal invoice berhasil dipulihkan menjadi posted");
      qcClient.invalidateQueries({ queryKey: ["/api/purchase-workflow/vendor-invoices", activeCompanyId] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Gagal memulihkan jurnal");
    } finally {
      setRecoveringId(null);
    }
  };

  const handleDelete = async (id: number) => {
    setDeletingId(id);
    try {
      const r = await apiFetch(
        `/purchase-workflow/vendor-invoices/${id}?company=${activeCompanyId}`,
        { method: "DELETE" },
      );
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error((err as Record<string, string>).error ?? "Gagal");
      }
      toast.success("Invoice berhasil dihapus");
      qcClient.invalidateQueries({ queryKey: ["/api/purchase-workflow/vendor-invoices", activeCompanyId] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Gagal menghapus invoice");
    } finally {
      setDeletingId(null);
      setConfirmDeleteId(null);
    }
  };

  const confirmTarget = vis.find((vi: Record<string, unknown>) => Number(vi.id) === confirmDeleteId);

  return (
    <AppShell>
      <div className="flex flex-col gap-6">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold">Vendor Invoice (AP)</h1>
            <p className="text-sm text-muted-foreground">Pusat tagihan supplier & 3-way matching</p>
          </div>
          <div className="flex gap-2 flex-wrap">
            <Link href="/purchase/vendor-invoices/import"><Button variant="outline"><Bot className="mr-2 h-4 w-4 text-indigo-500" />Import via AI</Button></Link>
            <Link href="/purchase/vendor-invoices/new"><Button variant="outline"><Plus className="mr-2 h-4 w-4" />Buat Invoice</Button></Link>
            <Link href="/accounting/bank-disbursements?mode=vendor_invoice">
              <Button className="bg-orange-600 hover:bg-orange-700 text-white gap-2">
                <Banknote className="h-4 w-4" />Buat Bank Disbursement
              </Button>
            </Link>
          </div>
        </div>

        {/* Dialog konfirmasi hapus */}
        {confirmDeleteId !== null && confirmTarget && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
            <div className="bg-background border rounded-lg shadow-lg p-6 w-full max-w-sm mx-4">
              <h2 className="text-lg font-semibold mb-1">Hapus Invoice?</h2>
              <p className="text-sm text-muted-foreground mb-1">
                <span className="font-mono font-medium text-foreground">{String(confirmTarget.invoiceNumber)}</span> — {String(confirmTarget.supplierName)}
              </p>
              <p className="text-sm text-destructive mb-4">Tindakan ini tidak dapat dibatalkan.</p>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setConfirmDeleteId(null)} disabled={deletingId === confirmDeleteId}>
                  Batal
                </Button>
                <Button
                  variant="destructive"
                  disabled={deletingId === confirmDeleteId}
                  onClick={() => handleDelete(confirmDeleteId)}
                >
                  {deletingId === confirmDeleteId ? "Menghapus..." : "Ya, Hapus"}
                </Button>
              </div>
            </div>
          </div>
        )}

        {repairInvoiceId !== null && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
            <div className="max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-lg border bg-background p-6 shadow-xl">
              <div className="mb-4">
                <h2 className="text-lg font-semibold">Perbaiki rincian PPh legacy</h2>
                <p className="text-sm text-muted-foreground">
                  {repairPreview?.invoiceNumber} — {repairPreview?.supplierName}
                </p>
              </div>
              {repairPreviewLoading ? <div className="py-8 text-center">Memuat rincian...</div> : (
                <div className="space-y-4">
                  <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                    <p className="font-medium">{repairPreview?.reason}</p>
                    <p className="mt-1 text-xs">Grand total invoice tetap {idr(repairPreview?.grandTotal)}. Perbaikan hanya mengganti rincian PPh dan pemetaan COA.</p>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[760px] text-sm">
                      <thead><tr className="border-b">
                        <th className="px-2 py-2 text-left">Jenis PPh</th>
                        <th className="px-2 py-2 text-left">Tax object</th>
                        <th className="px-2 py-2 text-right">DPP</th>
                        <th className="px-2 py-2 text-right">PPh</th>
                        <th className="px-2 py-2 text-left">COA liabilitas aktif</th>
                      </tr></thead>
                      <tbody>{repairRows.map((row, index) => (
                        <tr key={`${row.invoiceLineId}-${index}`} className="border-b">
                          <td className="px-2 py-2">
                            <Input value={row.taxType} placeholder="Contoh: PPh 23" onChange={(event) =>
                              setRepairRows((current) => current.map((item, itemIndex) =>
                                itemIndex === index ? { ...item, taxType: event.target.value } : item))} />
                          </td>
                          <td className="px-2 py-2">
                            <Input value={row.taxObject} placeholder="Objek pajak" onChange={(event) =>
                              setRepairRows((current) => current.map((item, itemIndex) =>
                                itemIndex === index ? { ...item, taxObject: event.target.value } : item))} />
                          </td>
                          <td className="px-2 py-2">
                            <Input type="number" min="0" value={row.baseAmount} className="text-right font-mono"
                              onChange={(event) => setRepairRows((current) => current.map((item, itemIndex) =>
                                itemIndex === index ? { ...item, baseAmount: Number(event.target.value) } : item))} />
                          </td>
                          <td className="px-2 py-2">
                            <Input type="number" min="0.01" value={row.taxAmount} className="text-right font-mono"
                              onChange={(event) => setRepairRows((current) => current.map((item, itemIndex) =>
                                itemIndex === index ? { ...item, taxAmount: Number(event.target.value) } : item))} />
                          </td>
                          <td className="px-2 py-2">
                            <div className="flex gap-1">
                              <Select
                                value={row.liabilityAccountId ? String(row.liabilityAccountId) : ""}
                                onValueChange={(value) => setRepairRows((current) => current.map((item, itemIndex) =>
                                  itemIndex === index ? { ...item, liabilityAccountId: Number(value) } : item))}
                              >
                                <SelectTrigger><SelectValue placeholder="Pilih akun..." /></SelectTrigger>
                                <SelectContent>{repairAccounts.map((account) => (
                                  <SelectItem key={account.id} value={String(account.id)}>
                                    {account.code} — {account.name}
                                  </SelectItem>
                                ))}</SelectContent>
                              </Select>
                              {repairRows.length > 1 && (
                                <Button size="icon" variant="ghost"
                                  onClick={() => setRepairRows((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                                  title="Hapus baris">
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}</tbody>
                    </table>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <Button size="sm" variant="outline" onClick={() => setRepairRows((current) => {
                      const source = current[current.length - 1];
                      return source ? [...current, {
                        ...source,
                        taxType: "",
                        taxObject: "",
                        baseAmount: 0,
                        taxAmount: 0,
                        liabilityAccountId: null,
                      }] : current;
                    })}>
                      <Split className="mr-1 h-4 w-4" />Tambah baris split
                    </Button>
                    <p className="text-sm font-medium">
                      Total PPh: {idr(repairRows.reduce((sum, row) => sum + Number(row.taxAmount || 0), 0))}
                    </p>
                  </div>
                  <div>
                    <Label>Alasan perbaikan</Label>
                    <Textarea
                      value={repairReason}
                      onChange={(event) => setRepairReason(event.target.value)}
                      placeholder="Jelaskan sumber data dan alasan koreksi (minimal 10 karakter)."
                    />
                  </div>
                  <div className="flex justify-end gap-2">
                    <Button variant="outline" onClick={() => setRepairInvoiceId(null)} disabled={repairMut.isPending}>Batal</Button>
                    <Button
                      onClick={() => repairMut.mutate()}
                      disabled={repairMut.isPending || repairReason.trim().length < 10 || repairRows.some((row) =>
                        !row.liabilityAccountId || !row.taxType.trim() || !row.taxObject.trim() || row.taxAmount <= 0)}
                    >
                      {repairMut.isPending ? "Menyimpan..." : "Simpan perbaikan"}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {!repairQueueLoading && repairQueue.length > 0 && (
          <Card className="border-amber-300">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Wrench className="h-5 w-5 text-amber-600" />
                Perbaikan PPh legacy ({repairQueue.length})
              </CardTitle>
              <p className="text-sm text-muted-foreground">
                Invoice berikut diblokir dari pembayaran sampai rincian PPh dan COA liabilitas diperbaiki.
              </p>
            </CardHeader>
            <CardContent className="space-y-2">
              {repairQueue.map((item) => (
                <div key={item.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3">
                  <div>
                    <p className="font-medium">{item.invoiceNumber} — {item.supplierName}</p>
                    <p className="text-xs text-amber-700">{item.reason}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {item.componentCount} komponen · PPh {idr(item.withholdingAmount)} · Grand total {idr(item.grandTotal)}
                    </p>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => setRepairInvoiceId(item.id)}>
                    <Wrench className="mr-1 h-4 w-4" />Perbaiki
                  </Button>
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><FileText className="h-5 w-5" />Daftar Vendor Invoice</CardTitle></CardHeader>
          <CardContent>
            {isCompanyLoading || isLoading ? <div className="text-center py-8">Loading...</div> : activeCompanyId == null ? (
              <div className="flex flex-col items-center gap-3 py-8 text-center">
                <p className="text-sm text-muted-foreground">
                  Perusahaan belum tersedia. Silakan muat ulang data perusahaan.
                </p>
                <Button variant="outline" onClick={() => void refetchCompanies()}>
                  Muat ulang
                </Button>
              </div>
            ) : isError ? (
              <div className="text-center py-8 text-destructive">
                Gagal memuat vendor invoice: {error instanceof Error ? error.message : "Terjadi kesalahan."}
              </div>
            ) : vis.length === 0 ? <div className="text-center py-8 text-muted-foreground">Belum ada vendor invoice</div> : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="border-b">
                    <th className="text-left py-2 px-3">No. Invoice</th>
                    <th className="text-left py-2 px-3">Supplier</th>
                    <th className="text-left py-2 px-3">Status</th>
                    <th className="text-left py-2 px-3">3-Way Match</th>
                    <th className="text-right py-2 px-3">Grand Total</th>
                    <th className="text-right py-2 px-3">PPh</th>
                    <th className="text-right py-2 px-3">Terbayar</th>
                    <th className="text-right py-2 px-3">Sisa</th>
                    <th className="text-right py-2 px-3">Aksi</th>
                  </tr></thead>
                  <tbody>
                    {vis.map((vi: Record<string, unknown>) => (
                      <tr key={String(vi.id)} className="border-b hover:bg-muted/50">
                        <td className="py-2 px-3 font-mono text-xs">{String(vi.invoiceNumber)}</td>
                        <td className="py-2 px-3">{String(vi.supplierName)}</td>
                        <td className="py-2 px-3">
                          <Badge variant={vi.status === "paid" ? "default" : vi.status === "cancelled" ? "destructive" : vi.status === "posted" || vi.status === "matched" ? "secondary" : "outline"}>
                            {String(vi.status)}
                          </Badge>
                        </td>
                        <td className="py-2 px-3"><Badge variant={vi.threeWayMatchStatus === "matched" ? "default" : vi.threeWayMatchStatus === "partial" ? "secondary" : "outline"} className="text-xs">{String(vi.threeWayMatchStatus)}</Badge></td>
                        <td className="py-2 px-3 text-right font-mono">{idr(canonicalGrandTotal(vi))}</td>
                        <td className="py-2 px-3 text-right">
                          <div className="font-mono text-amber-600">{idr(canonicalWithholdingAmount(vi))}</div>
                          {vendorInvoiceWithholdingLabel(vi) && (
                            <div className="mt-0.5 text-[10px] text-muted-foreground">
                              {vendorInvoiceWithholdingLabel(vi)}
                            </div>
                          )}
                        </td>
                        <td className="py-2 px-3 text-right font-mono text-muted-foreground">{idr(canonicalAmountPaid(vi))}</td>
                        <td className="py-2 px-3 text-right font-mono text-red-600">{idr(outstandingNetPayment(vi))}</td>
                        <td className="py-2 px-3">
                          <div className="flex items-center justify-end gap-1">
                            {vi.status === "draft" && (
                              <Button
                                size="sm"
                                variant="default"
                                className="h-7 px-2 text-xs gap-1 bg-emerald-600 hover:bg-emerald-700"
                                disabled={postingId === Number(vi.id)}
                                onClick={() => handlePost(Number(vi.id))}
                              >
                                <Send className="h-3 w-3" />
                                {postingId === Number(vi.id) ? "..." : "Post"}
                              </Button>
                            )}
                            {vi.status === "posted" && vi.journalStatus === "draft" && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 px-2 text-xs gap-1 text-amber-700 border-amber-300 hover:bg-amber-50"
                                disabled={recoveringId === Number(vi.id)}
                                onClick={() => handleRecover(Number(vi.id))}
                                title={String(vi.journalEntryNumber ?? "Journal draft")}
                              >
                                <RotateCcw className="h-3 w-3" />
                                {recoveringId === Number(vi.id) ? "..." : "Pulihkan Jurnal"}
                              </Button>
                            )}
                            {(vi.status === "posted" || vi.status === "matched") && outstandingNetPayment(vi) > 0.01 && (
                              <Link href={`/accounting/bank-disbursements?mode=vendor_invoice&invoiceIds=${vi.id}`}>
                                <Button size="sm" variant="outline" className="h-7 px-2 text-xs gap-1 text-orange-600 border-orange-300 hover:bg-orange-50">
                                  <Banknote className="h-3 w-3" />Bayar
                                </Button>
                              </Link>
                            )}
                            <Link href={`/purchase/vendor-invoices/${vi.id}`}>
                              <Button variant="ghost" size="sm" className="h-7 w-7 p-0"><Eye className="h-4 w-4" /></Button>
                            </Link>
                            {vi.status !== "paid" && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 w-7 p-0 text-destructive hover:text-destructive hover:bg-destructive/10"
                                onClick={() => setConfirmDeleteId(Number(vi.id))}
                                title="Hapus invoice"
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="flex items-center justify-between gap-3 border-t px-3 py-3 text-xs text-muted-foreground">
                  <span>
                    Menampilkan {((page - 1) * pageSize) + 1}–{Math.min(page * pageSize, invoicePage?.total ?? vis.length)}
                    {" "}dari {invoicePage?.total ?? vis.length} invoice
                    {isFetching ? " · Memuat..." : ""}
                  </span>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 gap-1"
                      disabled={page <= 1 || isFetching}
                      onClick={() => setPage((current) => Math.max(1, current - 1))}
                    >
                      <ChevronLeft className="h-4 w-4" /> Sebelumnya
                    </Button>
                    <span className="min-w-20 text-center">Halaman {page} / {totalPages}</span>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 gap-1"
                      disabled={!invoicePage?.hasMore || isFetching}
                      onClick={() => setPage((current) => current + 1)}
                    >
                      Berikutnya <ChevronRight className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}

export function VendorInvoiceEditorPage() {
  const { id } = useParams();
  const search = useSearch();
  const sp = new URLSearchParams(search);
  const [, navigate] = useLocation();
  const qcClient = useQueryClient();
  const { activeCompanyId, isLoading: isCompanyLoading, refetch: refetchCompanies } = useCompany();
  const isNew = !id || id === "new";

  const { data: vi, isLoading, isError, error } = useQuery<VI>({
    queryKey: ["/api/purchase-workflow/vendor-invoices", id, activeCompanyId],
    queryFn: async () => {
      const response = await vendorInvoiceFetch(
        `/api/purchase-workflow/vendor-invoices/${id}?company=${activeCompanyId}`,
        { credentials: "include", headers: { "Content-Type": "application/json" } },
      );
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const message = payload && typeof payload === "object"
          ? String((payload as { error?: unknown; message?: unknown }).error
            ?? (payload as { message?: unknown }).message
            ?? "Gagal memuat detail vendor invoice.")
          : "Gagal memuat detail vendor invoice.";
        throw new Error(message);
      }
      return payload as VI;
    },
    enabled: !isNew && activeCompanyId != null,
  });
  const { data: repairHistory = [], isLoading: repairHistoryLoading, isError: repairHistoryError } = useQuery<LegacyRepairAuditEvent[]>({
    queryKey: ["/api/purchase-workflow/vendor-invoices/legacy-withholding-repair-history", id, activeCompanyId],
    queryFn: async () => {
      const response = await apiFetch(
        `/purchase-workflow/vendor-invoices/${id}/legacy-withholding-repair-history?company=${activeCompanyId}`,
      );
      const payload = await response.json().catch(() => null) as { data?: unknown } | null;
      if (!response.ok || !Array.isArray(payload?.data)) {
        throw new Error("Riwayat perbaikan PPh gagal dimuat.");
      }
      return payload.data as LegacyRepairAuditEvent[];
    },
    enabled: !isNew && activeCompanyId != null,
  });
  const hasActiveWithholding = vi != null && (
    canonicalWithholdingAmount(vi) > 0
    || (vi.lineTaxes ?? []).some((tax) => Number(tax.taxAmount) > 0)
    || (vi.lines ?? []).some((line) => Number(line.withholdingAmount ?? 0) > 0)
  );
  const { data: liabilityAccounts = [], isLoading: liabilityAccountsLoading } = useQuery<LiabilityAccount[]>({
    queryKey: ["/api/purchase-workflow/vendor-invoices/liability-accounts", activeCompanyId],
    queryFn: async () => {
      const response = await apiFetch(`/purchase-workflow/vendor-invoices/liability-accounts?company=${activeCompanyId}`);
      const payload = await response.json().catch(() => null);
      if (!response.ok || !Array.isArray(payload)) {
        throw new Error("Gagal memuat akun liabilitas PPh.");
      }
      return payload as LiabilityAccount[];
    },
    enabled: !isNew && activeCompanyId != null && hasActiveWithholding,
  });
  const refreshInvoiceDetail = async (): Promise<VI> => {
    const response = await apiFetch(
      `/purchase-workflow/vendor-invoices/${id}?company=${activeCompanyId}`,
      { cache: "no-store" },
    );
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload || typeof payload !== "object") {
      throw new Error("Detail invoice terbaru gagal dimuat.");
    }
    const latestInvoice = payload as VI;
    qcClient.setQueryData(
      ["/api/purchase-workflow/vendor-invoices", id, activeCompanyId],
      latestInvoice,
    );
    await qcClient.invalidateQueries({
      queryKey: ["/api/purchase-workflow/vendor-invoices", id, activeCompanyId],
    });
    await qcClient.invalidateQueries({
      queryKey: ["/api/purchase-workflow/vendor-invoices", activeCompanyId],
    });
    return latestInvoice;
  };

  const [form, setForm] = useState({ supplierName: "", vendorInvoiceRef: "", poId: sp.get("poId") ?? "", grId: sp.get("grId") ?? "", invoiceDate: new Date().toISOString().substring(0, 10), paymentTermDays: "30", notes: "" });
  const emptyLine = (): VILine => ({ name: "", quantity: "1", unit: "pcs", unitCost: "0", subtotal: "0", taxAmount: "0", coaAccountId: "", taxType: "", taxObject: "", withholdingAmount: "0", liabilityAccountId: "", notes: "" });
  const [lines, setLines] = useState<VILine[]>([emptyLine()]);

  useEffect(() => {
    if (vi) {
      setForm({ supplierName: vi.supplierName, vendorInvoiceRef: vi.vendorInvoiceRef ?? "", poId: String(vi.poId ?? ""), grId: String(vi.grId ?? ""), invoiceDate: vi.invoiceDate?.substring(0, 10) ?? new Date().toISOString().substring(0, 10), paymentTermDays: String(vi.paymentTermDays ?? 30), notes: "" });
       setLines(vi.lines?.length ? vi.lines.map((l, lineIndex) => {
         const tax = vi.lineTaxes?.find((candidate) => candidate.invoiceLineId === l.id);
         const breakdownTax = vi.invoiceBreakdown?.components?.[lineIndex];
         const withholdingAmount = tax && Number(tax.taxAmount) > 0
           ? String(tax.taxAmount)
           : breakdownTax?.withholding_tax_amount != null
             ? String(breakdownTax.withholding_tax_amount)
             : "0";
        return {
          ...l,
          quantity: String(l.quantity),
          unitCost: String(l.unitCost),
          subtotal: String(l.subtotal),
          taxAmount: String(l.taxAmount),
          coaAccountId: l.coaAccountId ? String(l.coaAccountId) : "",
           taxType: tax?.taxType ?? breakdownTax?.withholding_tax_type ?? "",
           taxObject: tax?.taxObject ?? breakdownTax?.withholding_tax_type ?? "",
           withholdingAmount,
          liabilityAccountId: tax?.liabilityAccountId ? String(tax.liabilityAccountId) : "",
        };
      }) : []);
    }
  }, [vi]);

  // The invoice carries the tax type and amount, while the GL account comes
  // from the company's COA. Apply the company's deterministic tax-account
  // convention as soon as both the invoice and liability account list exist.
  // Users can still override the suggestion before posting.
  useEffect(() => {
    if (!liabilityAccounts.length) return;
    setLines((current) => {
      let changed = false;
      const next = current.map((line) => {
        if (line.liabilityAccountId || Number(line.withholdingAmount ?? 0) <= 0) return line;
        const taxType = `${line.taxType ?? ""} ${line.taxObject ?? ""}`.toLowerCase();
        const taxNumber = taxType.match(/pph\s*(?:pasal\s*)?(\d+)/i)?.[1];
        const exactName = taxType.includes("4(2)") || taxType.includes("4 ayat 2")
          ? /hutang pph final pasal 4 ayat 2/i
          : taxType.includes("pph 15")
            ? /hutang pph final pasal 15/i
            : new RegExp(`hutang pph(?: pasal)? ${taxNumber ?? "___"}`, "i");
        const suggested = taxType.includes("pph 15")
          ? liabilityAccounts.find(
              (account) =>
                account.code.startsWith("2-1102-") ||
                /hutang pph final pasal 15/i.test(account.name),
            )
          : liabilityAccounts.find((account) => exactName.test(account.name));
        if (!suggested) return line;
        changed = true;
        return { ...line, liabilityAccountId: String(suggested.id) };
      });
      return changed ? next : current;
    });
  }, [liabilityAccounts, lines]);

  const updateLine = (i: number, key: keyof VILine, value: string) => setLines(prev => {
    const updated = prev.map((l, idx) => idx === i ? { ...l, [key]: value } : l);
    const line = updated[i];
    if (line && (key === "quantity" || key === "unitCost")) updated[i] = { ...line, subtotal: String((Number(line.quantity) * Number(line.unitCost)).toFixed(2)) };
    return updated;
  });

  const saveMut = useMutation({
    mutationFn: async () => {
      const payload = {
        ...form,
        poId: form.poId ? Number(form.poId) : undefined,
        grId: form.grId ? Number(form.grId) : undefined,
        companyId: activeCompanyId,
        lines: lines.map((line) => ({
          ...line,
          coaAccountId: line.coaAccountId ? Number(line.coaAccountId) : undefined,
          withholdingTaxes: Number(line.withholdingAmount ?? 0) > 0 ? [{
            taxType: line.taxType,
            taxObject: line.taxObject,
            taxAmount: Number(line.withholdingAmount),
            liabilityAccountId: line.liabilityAccountId ? Number(line.liabilityAccountId) : undefined,
          }] : undefined,
        })),
      };
      const r = isNew ? await apiFetch("/purchase-workflow/vendor-invoices", { method: "POST", body: JSON.stringify(payload) }) : await apiFetch(`/purchase-workflow/vendor-invoices/${id}`, { method: "PUT", body: JSON.stringify(payload) });
      if (!r.ok) throw new Error();
      const saved = await r.json() as VI;
      // PUT recreates invoice lines, so their database IDs may change. Always
      // read the saved detail before Finance Review instead of submitting stale
      // IDs from the form state.
      const fresh = await apiFetch(`/purchase-workflow/vendor-invoices/${saved.id}?company=${activeCompanyId}`)
        .then(async (response) => {
          if (!response.ok) throw new Error("Invoice tersimpan, tetapi detail terbaru gagal dimuat.");
          return response.json() as Promise<VI>;
        });
      const freshLines = fresh.lines ?? [];
      const reviewLines = lines.map((line, index) => ({
        lineId: freshLines[index]?.id,
        coaAccountId: Number(line.coaAccountId),
        mappingKey: line.name,
        saveReusableRule: true,
      })).filter((line) => line.lineId && line.coaAccountId);
      const reviewTaxes = lines.map((line, index) => ({
        invoiceLineId: freshLines[index]?.id,
        taxType: line.taxType,
        taxObject: line.taxObject,
        baseAmount: Number(line.subtotal),
        taxAmount: Number(line.withholdingAmount),
        liabilityAccountId: Number(line.liabilityAccountId),
      })).filter((line) => line.invoiceLineId && line.taxAmount > 0 && line.taxType && line.taxObject && line.liabilityAccountId);
      if (saved.id && (reviewLines.length > 0 || reviewTaxes.length > 0)) {
        const reviewResponse = await apiFetch(`/purchase-workflow/vendor-invoices/${saved.id}/finance-review?company=${activeCompanyId}`, {
          method: "PUT",
          body: JSON.stringify({ lines: reviewLines, taxes: reviewTaxes }),
        });
        if (!reviewResponse.ok) {
          const body = await reviewResponse.json().catch(() => ({}));
          throw new Error(formatPostingError(body, "Finance Review gagal disimpan."));
        }
      }
      return fresh;
    },
    onSuccess: (data: VI) => { toast.success("Tersimpan"); qcClient.invalidateQueries({ queryKey: ["/api/purchase-workflow/vendor-invoices"] }); if (isNew) navigate(`/purchase/vendor-invoices/${data.id}`); },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Gagal"),
  });

  const postMut = useMutation({
    mutationFn: async () => {
      // Users commonly edit the imported values and click Post directly.
      // Persist the current form and its Finance Review first so posting reads
      // the same values and confirmed tax accounts visible on screen.
      const reviewedTaxes = vi?.lineTaxes?.filter((tax) => Number(tax.taxAmount) > 0) ?? [];
      const financeReviewComplete = reviewedTaxes.length > 0 && reviewedTaxes.every((tax) => {
        const record = vi?.withholdingRecords?.find((candidate) =>
          (tax.id != null && candidate.lineTaxId === tax.id) ||
          candidate.invoiceLineId === tax.invoiceLineId,
        );
        return Boolean(
          tax.liabilityAccountId &&
          ["confirmed", "approved"].includes(String(tax.resolutionStatus)) &&
          ["proof_pending", "proof_received", "posted"].includes(String(record?.status)),
        );
      });
      if (!financeReviewComplete) {
        await saveMut.mutateAsync();
      }
      const r = await apiFetch(`/purchase-workflow/vendor-invoices/${vi?.id}/post?company=${activeCompanyId}`, { method: "POST" });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(formatPostingError(body, "Gagal posting"));
      }
      return r.json();
    },
    onSuccess: async () => {
      toast.success("Invoice diposting & jurnal dibuat");
      await qcClient.invalidateQueries({
        queryKey: ["/api/purchase-workflow/vendor-invoices", activeCompanyId],
      });
      navigate("/purchase/vendor-invoices");
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Gagal posting"),
  });

  const recoverMut = useMutation({
    mutationFn: async () => {
      const r = await apiFetch(`/purchase-workflow/vendor-invoices/${vi?.id}/recover-journal?company=${activeCompanyId}`, { method: "POST" });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(formatPostingError(body, "Gagal memulihkan jurnal"));
      return body;
    },
    onSuccess: async () => {
      toast.success("Journal invoice berhasil dipulihkan menjadi posted");
      await qcClient.invalidateQueries({ queryKey: ["/api/purchase-workflow/vendor-invoices", id, activeCompanyId] });
      await qcClient.invalidateQueries({ queryKey: ["/api/purchase-workflow/vendor-invoices", activeCompanyId] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Gagal memulihkan jurnal"),
  });

  const resetPaymentMut = useMutation({
    mutationFn: async (reason: string) => {
      const r = await apiFetch(`/purchase-workflow/vendor-invoices/${vi?.id}/reset-payment?company=${activeCompanyId}`, {
        method: "POST",
        body: JSON.stringify({ reason }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || hasPaymentResetBlockers(body)) {
        throw new Error(formatPostingError(
          body,
          "Reset ditolak karena masih ada payment link atau pembayaran bank yang aktif.",
        ));
      }
      return body;
    },
    onSuccess: async (resetResponse) => {
      const detailResponse = await apiFetch(
        `/purchase-workflow/vendor-invoices/${id}?company=${activeCompanyId}`,
        { cache: "no-store" },
      );
      const resetInvoice = resetResponse?.invoice as Partial<VI> | undefined;
      const latestInvoice = detailResponse.ok
        ? await detailResponse.json().catch(() => null) as Partial<VI> | null
        : resetInvoice ?? null;
      if (detailResponse.ok && latestInvoice) {
        qcClient.setQueryData(["/api/purchase-workflow/vendor-invoices", id, activeCompanyId], latestInvoice);
      } else if (resetInvoice) {
        qcClient.setQueryData(["/api/purchase-workflow/vendor-invoices", id, activeCompanyId], (current: VI | undefined) => ({
          ...current,
          ...resetInvoice,
        }));
      }
      if (detailResponse.ok) {
        await qcClient.invalidateQueries({ queryKey: ["/api/purchase-workflow/vendor-invoices", id, activeCompanyId] });
        await qcClient.invalidateQueries({ queryKey: ["/api/purchase-workflow/vendor-invoices", activeCompanyId] });
      } else if (resetInvoice) {
        qcClient.setQueryData(
          ["/api/purchase-workflow/vendor-invoices", activeCompanyId],
          (current: VendorInvoiceListItem[] | undefined) =>
            current?.map((item) => Number(item.id) === Number(id)
              ? { ...item, amountPaid: resetInvoice.amountPaid, status: resetInvoice.status }
              : item),
        );
      }
      const latestAmountPaid = canonicalAmountPaid(latestInvoice ?? {});
      if (latestAmountPaid <= 0.01) {
        toast.success("Status pembayaran dikoreksi menjadi belum terbayar");
      } else {
        toast.error(
          "Reset diterima, tetapi invoice masih terbaca sudah terbayar. Periksa settlement atau pembayaran bank yang masih tertaut.",
        );
      }
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Gagal mereset status pembayaran"),
  });

  const syncPaymentStatusMut = useMutation({
    mutationFn: async () => {
      const r = await apiFetch(`/purchase-workflow/vendor-invoices/${vi?.id}/recalculate-payment-status?company=${activeCompanyId}`, {
        method: "POST",
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(formatPostingError(body, "Gagal menyinkronkan status pembayaran"));
      return body;
    },
    onSuccess: async (body) => {
      // The operation response is not the display source. Read the refreshed
      // invoice so the UI only renders the canonical amount_paid value.
      void body;
      const latestInvoice = await refreshInvoiceDetail();
      const latestAmountPaid = canonicalAmountPaid(latestInvoice);
      toast.success(
        latestAmountPaid > 0
          ? `Status pembayaran tersinkron dari rekonsiliasi valid: ${idr(latestAmountPaid)}`
          : "Tidak ada pembayaran dari rekonsiliasi valid; Terbayar tetap Rp0",
      );
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Gagal menyinkronkan status pembayaran"),
  });

  const handleResetPayment = () => {
    if (!vi || canonicalAmountPaid(vi) <= 0) return;
    const reason = window.prompt(
      "Alasan koreksi pembayaran (minimal 10 karakter):",
      "Koreksi settlement orphan; invoice dikembalikan menjadi belum terbayar.",
    );
    if (!reason?.trim()) return;
    resetPaymentMut.mutate(reason.trim());
  };

  const isDraft = !vi || vi.status === "draft";
  if (!isNew && (isCompanyLoading || isLoading)) {
    return <AppShell><div className="flex items-center justify-center h-64">Loading...</div></AppShell>;
  }
  if (!isNew && activeCompanyId == null) {
    return (
      <AppShell>
        <div className="flex flex-col items-center justify-center gap-3 h-64 text-center">
          <p className="text-destructive">
            Perusahaan belum tersedia. Session Anda mungkin sudah berakhir.
          </p>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => void refetchCompanies()}>
              Muat ulang
            </Button>
            <Button variant="outline" onClick={() => navigate("/purchase/vendor-invoices")}>
              <ChevronLeft className="mr-1 h-4 w-4" />Kembali
            </Button>
          </div>
        </div>
      </AppShell>
    );
  }
  if (!isNew && isError) {
    return (
      <AppShell>
        <div className="flex flex-col items-center justify-center gap-3 h-64 text-center">
          <p className="text-destructive">
            Gagal memuat detail invoice: {error instanceof Error ? error.message : "Terjadi kesalahan."}
          </p>
          <Button variant="outline" onClick={() => navigate("/purchase/vendor-invoices")}>
            <ChevronLeft className="mr-1 h-4 w-4" />Kembali ke daftar invoice
          </Button>
        </div>
      </AppShell>
    );
  }

  const totalAmount = lines.reduce((s, l) => s + Number(l.subtotal), 0);
  const taxAmount = lines.reduce((s, l) => s + Number(l.taxAmount), 0);
  const summarySubtotal = vi ? Number(vi.totalAmount) : totalAmount;
  const summaryTax = vi ? Number(vi.taxAmount) : taxAmount;
  const summaryGrandTotal = vi ? canonicalGrandTotal(vi) : summarySubtotal + summaryTax;
  const lineWithholding = lines.reduce((sum, line) => sum + Number(line.withholdingAmount ?? 0), 0);
  const summaryWithholding = vi
    ? Math.max(canonicalWithholdingAmount(vi), lineWithholding)
    : lineWithholding;
  const withholdingLines = lines.filter((line) => Number(line.withholdingAmount ?? 0) > 0);
  const incompleteWithholdingLines = withholdingLines.filter((line) =>
    !line.taxType?.trim() || !line.taxObject?.trim() || !line.liabilityAccountId,
  );
  const paymentSummary = vi
    ? vendorInvoicePaymentSummary(vi, lineWithholding)
    : {
      amountPaid: 0,
      estimatedNet: Math.max(0, summaryGrandTotal - summaryWithholding),
      outstanding: 0,
    };
  const estimatedNetPayment = paymentSummary.estimatedNet;
  const amountPaid = paymentSummary.amountPaid;
  const outstandingPayment = paymentSummary.outstanding;

  return (
    <AppShell>
      <div className="flex flex-col gap-6 max-w-7xl">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => navigate("/purchase/vendor-invoices")}><ChevronLeft className="h-4 w-4" /></Button>
          <div className="flex-1">
            <h1 className="text-2xl font-bold">{isNew ? "Buat Vendor Invoice" : `Invoice: ${vi?.invoiceNumber}`}</h1>
            {vi && (
              <div className="flex gap-2 mt-1">
                <Badge variant={vi.status === "paid" ? "default" : vi.status === "cancelled" ? "destructive" : "secondary"}>{vi.status}</Badge>
                <Badge variant={vi.threeWayMatchStatus === "matched" ? "default" : "secondary"}>{vi.threeWayMatchStatus}</Badge>
              </div>
            )}
          </div>
          <div className="flex gap-2">
            {isDraft && <Button variant="outline" onClick={() => saveMut.mutate()} disabled={saveMut.isPending}>Simpan</Button>}
            {!isNew && isDraft && (
              <Button className="bg-emerald-600 hover:bg-emerald-700" onClick={() => postMut.mutate()} disabled={postMut.isPending || saveMut.isPending || liabilityAccountsLoading}>
                <Send className="mr-1 h-4 w-4" />{postMut.isPending ? "Memproses..." : "Post Invoice"}
              </Button>
            )}
            {!isNew && vi?.status === "posted" && vi?.journalStatus === "draft" && (
              <Button
                variant="outline"
                className="text-amber-700 border-amber-300 hover:bg-amber-50"
                onClick={() => recoverMut.mutate()}
                disabled={recoverMut.isPending}
              >
                <RotateCcw className="mr-1 h-4 w-4" />
                {recoverMut.isPending ? "Memulihkan..." : "Pulihkan Journal"}
              </Button>
            )}
            {!isNew && vi && canonicalAmountPaid(vi) > 0 && (
              <Button
                variant="outline"
                className="text-red-700 border-red-300 hover:bg-red-50"
                onClick={handleResetPayment}
                disabled={resetPaymentMut.isPending}
              >
                <RotateCcw className="mr-1 h-4 w-4" />
                {resetPaymentMut.isPending ? "Mengoreksi..." : "Reset Pembayaran"}
              </Button>
            )}
            {!isNew && vi && vi.status !== "paid" && vi.status !== "draft" && (
              <Button
                variant="outline"
                className="text-blue-700 border-blue-300 hover:bg-blue-50"
                onClick={() => syncPaymentStatusMut.mutate()}
                disabled={syncPaymentStatusMut.isPending}
              >
                <RefreshCw className={`mr-1 h-4 w-4 ${syncPaymentStatusMut.isPending ? "animate-spin" : ""}`} />
                {syncPaymentStatusMut.isPending ? "Menyinkronkan..." : "Sinkronkan Rekonsiliasi"}
              </Button>
            )}
          </div>
        </div>

        {/* Banner: draft — perlu dipost sebelum bisa dibayar */}
        {!isNew && isDraft && (
          <div className="flex items-center gap-3 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-800">
            <span className="text-lg">⚠️</span>
            <div>
              <p className="font-semibold">Invoice masih Draft</p>
              <p className="text-xs text-amber-700 mt-0.5">Klik <strong>"Post Invoice"</strong> untuk mengkonfirmasi & membuat jurnal. Setelah diposting, invoice bisa dibayar via Bank Disbursement.</p>
            </div>
          </div>
        )}
        {!isNew && vi?.status !== "draft" && vi?.journalStatus === "draft" && (
          <div className="flex items-center gap-3 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-800">
            <span className="text-lg">⚠️</span>
            <div>
              <p className="font-semibold">Invoice sudah posted, tetapi journal masih Draft</p>
              <p className="text-xs text-amber-700 mt-0.5">
                {vi.journalEntryNumber ? `Journal ${vi.journalEntryNumber} belum masuk Neraca Saldo.` : "Journal belum masuk Neraca Saldo."}
                {" "}Klik <strong>"Pulihkan Journal"</strong> setelah Finance memastikan detailnya balance.
              </p>
            </div>
          </div>
        )}
        {!isNew && isDraft && incompleteWithholdingLines.length > 0 && (
          <div className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
            <p className="font-semibold">Finance Review PPh belum lengkap</p>
            <p className="mt-0.5 text-xs">
              Pilih akun liabilitas PPh pada {incompleteWithholdingLines.length} line sebelum invoice dapat diposting.
            </p>
          </div>
        )}

        {vi?.matchNotes && (
          <div className={`p-3 rounded border text-sm ${vi.threeWayMatchStatus === "matched" ? "bg-green-50 border-green-200 text-green-800" : "bg-yellow-50 border-yellow-200 text-yellow-800"}`}>
            <strong>3-Way Match:</strong> {vi.matchNotes}
          </div>
        )}

        {!isNew && vi && vi.status === "posted" && outstandingPayment > 0.01 && (
          <div className="flex gap-2">
            <Link href={`/accounting/bank-disbursements?mode=vendor_invoice&invoiceIds=${vi.id}`}>
              <Button className="bg-orange-600 hover:bg-orange-700 text-white gap-1" size="sm">
                <Banknote className="mr-1 h-4 w-4" />Buat Bank Disbursement
              </Button>
            </Link>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card>
            <CardHeader><CardTitle className="text-base">Info Invoice</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <div><Label>Nama Supplier</Label><Input value={form.supplierName} onChange={e => setForm(f => ({ ...f, supplierName: e.target.value }))} disabled={!isDraft} /></div>
              <div><Label>No. Invoice Supplier</Label><Input value={form.vendorInvoiceRef} onChange={e => setForm(f => ({ ...f, vendorInvoiceRef: e.target.value }))} disabled={!isDraft} placeholder="Nomor dari supplier..." /></div>
              <div><Label>No. PO (ID)</Label><Input value={form.poId} onChange={e => setForm(f => ({ ...f, poId: e.target.value }))} disabled={!isDraft} /></div>
              <div><Label>No. GRN (ID)</Label><Input value={form.grId} onChange={e => setForm(f => ({ ...f, grId: e.target.value }))} disabled={!isDraft} /></div>
              <div><Label>Tgl Invoice</Label><DatePicker value={form.invoiceDate} onChange={v => setForm(f => ({ ...f, invoiceDate: v }))} disabled={!isDraft} /></div>
              <div><Label>Term Pembayaran (hari)</Label><Input type="number" value={form.paymentTermDays} onChange={e => setForm(f => ({ ...f, paymentTermDays: e.target.value }))} disabled={!isDraft} /></div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Ringkasan Nilai Invoice</CardTitle>
              <p className="text-xs text-muted-foreground">Grand Total adalah nilai bruto. PPh dipotong saat pembayaran vendor.</p>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="flex justify-between text-slate-500"><span>Subtotal</span><span className="font-mono">{idr(summarySubtotal)}</span></div>
              <div className="flex justify-between text-slate-500"><span>Pajak (PPN)</span><span className="font-mono">{idr(summaryTax)}</span></div>
              <div className="flex justify-between text-amber-600"><span>PPh dipotong saat bayar</span><span className="font-mono">{idr(summaryWithholding)}</span></div>
              <div className="flex justify-between font-bold text-lg border-t pt-2"><span>Grand Total (bruto)</span><span className="font-mono">{idr(summaryGrandTotal)}</span></div>
              <div className="flex justify-between font-semibold text-blue-600 border-t pt-2"><span>Estimasi transfer (neto)</span><span className="font-mono">{idr(estimatedNetPayment)}</span></div>
              {vi && (
                <div className={`flex justify-between ${amountPaid > 0 ? "text-green-600" : "text-muted-foreground"}`}>
                  <span>Terbayar</span>
                  <span className="font-mono">{idr(amountPaid)}</span>
                </div>
              )}
              {vi && <div className="flex justify-between font-semibold text-red-600"><span>Sisa</span><span className="font-mono">{idr(outstandingPayment)}</span></div>}
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle className="text-base">Rincian Item Invoice</CardTitle>
              <p className="text-xs text-muted-foreground mt-1">
                Masukkan nilai dalam rupiah. COA adalah akun beban; PPh adalah potongan pembayaran per baris.
              </p>
            </div>
            {isDraft && <Button size="sm" variant="outline" onClick={() => setLines(prev => [...prev, emptyLine()])}><Plus className="mr-1 h-4 w-4" />Tambah</Button>}
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1320px] text-sm">
                <thead><tr className="border-b">
                  <th className="text-left py-2 px-2 min-w-52"><span className="text-xs uppercase tracking-wide text-muted-foreground">Nama item</span></th>
                  <th className="text-left py-2 px-2 w-20"><span className="text-xs uppercase tracking-wide text-muted-foreground">Qty</span></th>
                  <th className="text-left py-2 px-2 w-20"><span className="text-xs uppercase tracking-wide text-muted-foreground">Satuan</span></th>
                  <th className="text-left py-2 px-2 w-40"><span className="text-xs uppercase tracking-wide text-muted-foreground">Harga satuan</span><span className="block text-[10px] font-normal text-muted-foreground">(Rp)</span></th>
                  <th className="text-left py-2 px-2 w-36"><span className="text-xs uppercase tracking-wide text-muted-foreground">PPN</span><span className="block text-[10px] font-normal text-muted-foreground">(Rp)</span></th>
                  <th className="text-left py-2 px-2 w-32"><span className="text-xs uppercase tracking-wide text-muted-foreground">COA beban</span><span className="block text-[10px] font-normal text-muted-foreground">(ID)</span></th>
                  <th className="text-left py-2 px-2 w-40"><span className="text-xs uppercase tracking-wide text-muted-foreground">PPh dipotong</span><span className="block text-[10px] font-normal text-muted-foreground">(Rp)</span></th>
                  <th className="text-left py-2 px-2 min-w-64"><span className="text-xs uppercase tracking-wide text-muted-foreground">Akun liabilitas PPh</span><span className="block text-[10px] font-normal text-muted-foreground">Wajib untuk Finance Review</span></th>
                  <th className="text-right py-2 px-2 w-36"><span className="text-xs uppercase tracking-wide text-muted-foreground">Subtotal</span><span className="block text-[10px] font-normal text-muted-foreground">(Rp)</span></th>
                  {isDraft && <th className="w-10" />}
                </tr></thead>
                <tbody>
                  {lines.map((line, i) => (
                    <tr key={i} className="border-b align-top">
                      <td className="py-2 px-2"><Input value={line.name} onChange={e => updateLine(i, "name", e.target.value)} disabled={!isDraft} className="h-9 min-w-48" aria-label={`Nama item ${i + 1}`} /></td>
                      <td className="py-2 px-2"><Input type="number" value={line.quantity} onChange={e => updateLine(i, "quantity", e.target.value)} disabled={!isDraft} className="h-9 w-20 text-right" aria-label={`Kuantitas item ${i + 1}`} /></td>
                      <td className="py-2 px-2"><Input value={line.unit} onChange={e => updateLine(i, "unit", e.target.value)} disabled={!isDraft} className="h-9 w-20" aria-label={`Satuan item ${i + 1}`} /></td>
                      <td className="py-2 px-2"><Input type="number" value={line.unitCost} onChange={e => updateLine(i, "unitCost", e.target.value)} disabled={!isDraft} className="h-9 w-36 text-right font-mono" aria-label={`Harga satuan item ${i + 1}`} /></td>
                      <td className="py-2 px-2"><Input type="number" value={line.taxAmount} onChange={e => updateLine(i, "taxAmount", e.target.value)} disabled={!isDraft} className="h-9 w-32 text-right font-mono" placeholder="0" aria-label={`PPN item ${i + 1}`} /></td>
                      <td className="py-2 px-2"><Input type="number" value={line.coaAccountId ?? ""} onChange={e => updateLine(i, "coaAccountId", e.target.value)} disabled={!isDraft} className="h-9 w-28 text-right font-mono" placeholder="ID akun" aria-label={`COA beban item ${i + 1}`} /></td>
                      <td className="py-2 px-2">
                        <Input type="number" value={line.withholdingAmount ?? "0"} onChange={e => updateLine(i, "withholdingAmount", e.target.value)} disabled={!isDraft} className="h-9 w-36 text-right font-mono" placeholder="0" aria-label={`PPh item ${i + 1}`} />
                        {line.taxType && <span className="mt-1 block text-[10px] text-amber-600">{line.taxType}</span>}
                      </td>
                      <td className="py-2 px-2">
                        {Number(line.withholdingAmount ?? 0) > 0 ? (
                          <div>
                            <Select
                              value={line.liabilityAccountId || undefined}
                              onValueChange={(value) => updateLine(i, "liabilityAccountId", value)}
                              disabled={!isDraft || liabilityAccountsLoading}
                            >
                              <SelectTrigger className="h-9">
                                <SelectValue placeholder={liabilityAccountsLoading ? "Memuat akun..." : "Pilih akun PPh"} />
                              </SelectTrigger>
                              <SelectContent searchPlaceholder="Cari kode atau nama akun...">
                                {liabilityAccounts.map((account) => (
                                  <SelectItem key={account.id} value={String(account.id)}>
                                    {account.code} — {account.name}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            {line.liabilityAccountId && (
                              <span className="mt-1 block text-[10px] text-emerald-600">Usulan akun otomatis — dapat diubah Finance</span>
                            )}
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">Tidak ada PPh</span>
                        )}
                      </td>
                      <td className="py-2 px-2 text-right font-mono text-xs whitespace-nowrap">{idr(Number(line.subtotal))}</td>
                      {isDraft && <td className="py-1 px-2"><Button size="icon" variant="ghost" onClick={() => setLines(prev => prev.filter((_, idx) => idx !== i))} className="h-8 w-8"><Trash2 className="h-4 w-4 text-destructive" /></Button></td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

        {!isNew && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Riwayat Perbaikan PPh Legacy</CardTitle>
              <p className="text-xs text-muted-foreground">
                Riwayat audit bersifat read-only dan hanya menampilkan perbaikan untuk perusahaan aktif.
              </p>
            </CardHeader>
            <CardContent>
              {repairHistoryLoading ? (
                <div className="py-4 text-sm text-muted-foreground">Memuat riwayat perbaikan...</div>
              ) : repairHistoryError ? (
                <div className="py-4 text-sm text-destructive">Riwayat perbaikan PPh gagal dimuat.</div>
              ) : repairHistory.length === 0 ? (
                <div className="py-4 text-sm text-muted-foreground">Belum ada perbaikan PPh legacy untuk invoice ini.</div>
              ) : (
                <div className="space-y-4">
                  {repairHistory.map((event) => (
                    <div key={event.id} className="rounded-lg border p-4">
                      <div className="grid gap-3 border-b pb-3 text-sm md:grid-cols-[1fr_1fr_2fr]">
                        <div>
                          <p className="text-xs text-muted-foreground">Actor</p>
                          <p className="font-medium">{event.actor || "system"}</p>
                        </div>
                        <div>
                          <p className="text-xs text-muted-foreground">Waktu</p>
                          <p className="font-medium">
                            {new Date(event.timestamp).toLocaleString("id-ID", { dateStyle: "medium", timeStyle: "short" })}
                          </p>
                        </div>
                        <div>
                          <p className="text-xs text-muted-foreground">Alasan perbaikan</p>
                          <p className="font-medium">{event.reason || "Tidak ada alasan tercatat."}</p>
                        </div>
                      </div>
                      <div className="mt-4 grid gap-4 xl:grid-cols-2">
                        {[
                          { label: "Sebelum perbaikan", rows: event.beforeRows },
                          { label: "Sesudah perbaikan", rows: event.afterRows },
                        ].map((section) => (
                          <div key={section.label} className="min-w-0">
                            <p className="mb-2 text-sm font-semibold">{section.label}</p>
                            {section.rows.length === 0 ? (
                              <p className="rounded-md bg-muted/40 px-3 py-3 text-xs text-muted-foreground">Tidak ada baris PPh.</p>
                            ) : (
                              <div className="overflow-x-auto rounded-md border">
                                <table className="w-full min-w-[620px] text-xs">
                                  <thead className="bg-muted/40">
                                    <tr className="border-b">
                                      <th className="px-2 py-2 text-left">Baris</th>
                                      <th className="px-2 py-2 text-left">Jenis PPh</th>
                                      <th className="px-2 py-2 text-left">Objek</th>
                                      <th className="px-2 py-2 text-right">DPP</th>
                                      <th className="px-2 py-2 text-right">PPh</th>
                                      <th className="px-2 py-2 text-right">COA</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {section.rows.map((row, index) => (
                                      <tr key={`${row.lineTaxId ?? "row"}-${index}`} className="border-b last:border-0">
                                        <td className="px-2 py-2 font-mono">{row.invoiceLineId ?? "—"}</td>
                                        <td className="px-2 py-2">{row.taxType || "—"}</td>
                                        <td className="px-2 py-2">{row.taxObject || "—"}</td>
                                        <td className="px-2 py-2 text-right font-mono">{idr(row.baseAmount)}</td>
                                        <td className="px-2 py-2 text-right font-mono">{idr(row.taxAmount)}</td>
                                        <td className="px-2 py-2 text-right font-mono">{row.liabilityAccountId ?? "—"}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </AppShell>
  );
}
