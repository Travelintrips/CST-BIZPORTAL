import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useCompany } from "@/contexts/CompanyContext";
import {
  AlertCircle,
  CheckCircle2,
  Link2,
  Loader2,
  Mail,
  RefreshCw,
  ShieldCheck,
  Unlink,
} from "lucide-react";

type GmailSourceStatus = {
  oauthConfigured: boolean;
  expectedEmail: string;
  connected: boolean;
  connectedEmail: string | null;
  lastSyncAt: string | null;
  lastSyncCount: number;
  lastSyncStatus: string | null;
  redirectUri: string;
  scope: string;
};

type ApiError = {
  error?: string;
  code?: string;
  redirectUri?: string;
};

function formatDateTime(value: string | null): string {
  if (!value) return "Belum pernah";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("id-ID", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

async function readJson<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const apiError = payload as ApiError;
    throw new Error(apiError.error || `HTTP ${response.status}`);
  }
  return payload as T;
}

export default function InvoiceSourcesTab() {
  const { activeCompanyId, isConsolidated } = useCompany();
  const [status, setStatus] = useState<GmailSourceStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [action, setAction] = useState<"connect" | "sync" | "disconnect" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const companyId = useMemo(() => {
    if (isConsolidated) return null;
    const parsed = Number(activeCompanyId);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }, [activeCompanyId, isConsolidated]);

  const callbackResult = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    const gmail = params.get("gmail");
    const reason = params.get("reason");
    if (gmail === "connected") {
      return {
        type: "success" as const,
        message: "Gmail berhasil dihubungkan. Jalankan Sync Now untuk menguji pembacaan email.",
      };
    }
    if (gmail === "error") {
      const reasonLabel: Record<string, string> = {
        invalid_state: "Sesi koneksi Google tidak valid atau sudah kedaluwarsa.",
        session_expired: "Sesi BizPortal sudah berakhir. Login ulang lalu hubungkan kembali.",
        actor_mismatch: "Akun BizPortal yang menyelesaikan koneksi berbeda dari akun yang memulainya.",
        access_denied: "Akses Gmail dibatalkan.",
        wrong_account: "Akun Google yang dipilih bukan travelincars01@gmail.com.",
        refresh_token_missing: "Google tidak memberikan refresh token. Hubungkan ulang dan setujui akses.",
        oauth_failed: "Proses OAuth Google gagal.",
        missing_code: "Kode otorisasi Google tidak diterima.",
      };
      return {
        type: "error" as const,
        message: reasonLabel[reason ?? ""] || "Koneksi Gmail gagal. Silakan coba lagi.",
      };
    }
    return null;
  }, []);

  const loadStatus = useCallback(async () => {
    if (!companyId) {
      setStatus(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/recon-classification/invoice-sources/gmail/status?company_id=${companyId}`,
        { credentials: "include" },
      );
      const payload = await readJson<GmailSourceStatus>(response);
      setStatus(payload);
    } catch (err) {
      setStatus(null);
      setError(err instanceof Error ? err.message : "Gagal membaca status Gmail.");
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const connect = async () => {
    if (!companyId) return;
    setAction("connect");
    setError(null);
    try {
      const returnPath = `${window.location.pathname}?tab=invoice-sources`;
      const response = await fetch(
        "/api/recon-classification/invoice-sources/gmail/connect",
        {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            company_id: companyId,
            return_path: returnPath,
          }),
        },
      );
      const payload = await readJson<{ url: string }>(response);
      window.location.assign(payload.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal memulai koneksi Gmail.");
      setAction(null);
    }
  };

  const sync = async () => {
    if (!companyId) return;
    setAction("sync");
    setError(null);
    try {
      const response = await fetch(
        "/api/recon-classification/invoice-sources/gmail/sync",
        {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ company_id: companyId }),
        },
      );
      await readJson(response);
      await loadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal membaca Gmail.");
    } finally {
      setAction(null);
    }
  };

  const disconnect = async () => {
    if (!companyId) return;
    const confirmed = window.confirm(
      "Putuskan Gmail dari sumber invoice BizPortal? Email di Gmail tidak akan dihapus.",
    );
    if (!confirmed) return;

    setAction("disconnect");
    setError(null);
    try {
      const response = await fetch(
        "/api/recon-classification/invoice-sources/gmail/disconnect",
        {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ company_id: companyId }),
        },
      );
      await readJson(response);
      await loadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal memutus koneksi Gmail.");
    } finally {
      setAction(null);
    }
  };

  if (isConsolidated) {
    return (
      <div className="rounded-lg border border-amber-700/50 bg-amber-950/20 p-4 text-sm text-amber-200">
        Pilih satu perusahaan terlebih dahulu. Sumber invoice Gmail disimpan per perusahaan,
        bukan pada mode konsolidasi.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {callbackResult && (
        <div
          className={
            callbackResult.type === "success"
              ? "flex items-start gap-2 rounded-lg border border-emerald-700/50 bg-emerald-950/20 p-4 text-sm text-emerald-200"
              : "flex items-start gap-2 rounded-lg border border-red-700/50 bg-red-950/20 p-4 text-sm text-red-200"
          }
        >
          {callbackResult.type === "success" ? (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          ) : (
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          )}
          <span>{callbackResult.message}</span>
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-red-700/50 bg-red-950/20 p-4 text-sm text-red-200">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <Card className="border-slate-700 bg-slate-900/70">
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-base text-white">
                <Mail className="h-4 w-4 text-orange-400" />
                Gmail Invoice Source
              </CardTitle>
              <p className="mt-1 text-sm text-slate-400">
                Baca email dan attachment invoice secara read-only untuk proses Match INV.
              </p>
            </div>
            {status?.connected ? (
              <Badge className="border-emerald-700 bg-emerald-950/40 text-emerald-300">
                Connected
              </Badge>
            ) : (
              <Badge variant="outline" className="border-slate-600 text-slate-300">
                Not connected
              </Badge>
            )}
          </div>
        </CardHeader>

        <CardContent className="space-y-5">
          {loading && !status ? (
            <div className="flex items-center gap-2 py-4 text-sm text-slate-400">
              <Loader2 className="h-4 w-4 animate-spin" />
              Membaca konfigurasi Gmail...
            </div>
          ) : (
            <>
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                <div className="rounded-lg border border-slate-700 bg-slate-950/40 p-3">
                  <p className="text-xs uppercase tracking-wide text-slate-500">Akun Gmail</p>
                  <p className="mt-1 text-sm font-semibold text-white">
                    {status?.connectedEmail || status?.expectedEmail || "travelincars01@gmail.com"}
                  </p>
                </div>
                <div className="rounded-lg border border-slate-700 bg-slate-950/40 p-3">
                  <p className="text-xs uppercase tracking-wide text-slate-500">Akses</p>
                  <p className="mt-1 flex items-center gap-1.5 text-sm font-semibold text-white">
                    <ShieldCheck className="h-4 w-4 text-emerald-400" />
                    Gmail read-only
                  </p>
                </div>
                <div className="rounded-lg border border-slate-700 bg-slate-950/40 p-3">
                  <p className="text-xs uppercase tracking-wide text-slate-500">Last Sync</p>
                  <p className="mt-1 text-sm font-semibold text-white">
                    {formatDateTime(status?.lastSyncAt ?? null)}
                  </p>
                </div>
                <div className="rounded-lg border border-slate-700 bg-slate-950/40 p-3">
                  <p className="text-xs uppercase tracking-wide text-slate-500">
                    Kandidat Email Terakhir
                  </p>
                  <p className="mt-1 text-sm font-semibold text-white">
                    {status?.lastSyncCount ?? 0} email
                  </p>
                </div>
              </div>

              {!status?.oauthConfigured && (
                <div className="rounded-lg border border-amber-700/50 bg-amber-950/20 p-4 text-sm text-amber-200">
                  Google OAuth server belum lengkap. Tambahkan GOOGLE_CLIENT_ID dan
                  GOOGLE_CLIENT_SECRET pada environment BizPortal, lalu daftarkan callback berikut
                  di Google Cloud OAuth:
                  <code className="mt-2 block break-all rounded bg-black/30 p-2 text-xs text-amber-100">
                    {status?.redirectUri || "Callback URI akan tampil setelah konfigurasi server terbaca."}
                  </code>
                </div>
              )}

              <div className="flex flex-wrap gap-2">
                {!status?.connected ? (
                  <Button
                    onClick={() => void connect()}
                    disabled={!companyId || !status?.oauthConfigured || action !== null}
                    className="gap-2"
                  >
                    {action === "connect" ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Link2 className="h-4 w-4" />
                    )}
                    Connect Gmail
                  </Button>
                ) : (
                  <>
                    <Button
                      onClick={() => void sync()}
                      disabled={action !== null}
                      className="gap-2"
                    >
                      {action === "sync" ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <RefreshCw className="h-4 w-4" />
                      )}
                      Sync Now
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => void disconnect()}
                      disabled={action !== null}
                      className="gap-2 border-slate-600"
                    >
                      {action === "disconnect" ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Unlink className="h-4 w-4" />
                      )}
                      Disconnect
                    </Button>
                  </>
                )}
                <Button
                  variant="ghost"
                  onClick={() => void loadStatus()}
                  disabled={loading || action !== null}
                  className="gap-2 text-slate-300"
                >
                  <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
                  Refresh Status
                </Button>
              </div>

              <div className="border-t border-slate-800 pt-4 text-xs leading-5 text-slate-500">
                Koneksi ini tidak meminta password Gmail dan tidak dapat menghapus atau mengirim
                email. Tahap ini memverifikasi akses Gmail dan membaca daftar email ber-attachment
                yang menyerupai invoice. Dokumen tidak diposting ke accounting tanpa proses
                pencocokan dan approval.
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
