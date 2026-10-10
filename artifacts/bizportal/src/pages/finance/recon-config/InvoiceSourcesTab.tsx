import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useCompany } from "@/contexts/CompanyContext";
import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  FileText,
  Link2,
  Loader2,
  Mail,
  RefreshCw,
  ShieldCheck,
  Unlink,
} from "lucide-react";

type GmailSourceStatus = {
  oauthConfigured: boolean;
  aiConfigured: boolean;
  expectedEmail: string;
  connected: boolean;
  connectedEmail: string | null;
  lastSyncAt: string | null;
  lastSyncCount: number;
  lastSyncStatus: string | null;
  redirectUri: string;
  scope: string;
  organizerRuleCount: number;
  organizerActiveCount: number;
  organizerErrorCount: number;
};

type GmailOrganizationRule = {
  id: number;
  companyId: number;
  labelName: string;
  fromPattern: string | null;
  subjectPattern: string | null;
  isActive: boolean;
  gmailLabelId: string | null;
  gmailFilterId: string | null;
  status: string;
  lastAppliedAt: string | null;
  lastError: string | null;
};

type GmailCandidate = {
  id: number;
  messageId: string;
  senderEmail: string | null;
  senderName: string | null;
  subject: string | null;
  receivedAt: string | null;
  fileName: string;
  mimeType: string | null;
  size: number | null;
  vendorName: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  dueDate: string | null;
  currency: string | null;
  subtotal: number | null;
  tax: number | null;
  total: number | null;
  confidence: number | null;
  extractionStatus: string;
  status: string;
  vendorInvoiceId: number | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

type SyncResult = {
  ok: boolean;
  email: string;
  messagesScanned: number;
  attachmentsSeen: number;
  ready: number;
  manualReview: number;
  duplicates: number;
  failed: number;
  existing: number;
  syncedAt: string;
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

function formatInvoiceDate(value: string | null): string {
  if (!value) return "—";
  const datePart = value.slice(0, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(datePart);
  if (!match) return "—";
  const [, year, month, day] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  if (date.getFullYear() !== Number(year) || date.getMonth() !== Number(month) - 1 || date.getDate() !== Number(day)) return "—";
  return date.toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" });
}

function formatMoney(
  value: number | null,
  currency = "IDR",
): string {
  if (value == null || !Number.isFinite(value)) return "—";
  try {
    return new Intl.NumberFormat("id-ID", {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(value);
  } catch {
    return new Intl.NumberFormat("id-ID").format(value);
  }
}

function formatConfidence(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${Math.round(value * 100)}%`;
}

function statusBadge(status: string) {
  const normalized = status.toLowerCase();

  if (normalized === "ready") {
    return (
      <Badge className="border-emerald-700 bg-emerald-950/40 text-emerald-300">
        Siap dibuat draft
      </Badge>
    );
  }

  if (normalized === "imported") {
    return (
      <Badge className="border-blue-700 bg-blue-950/40 text-blue-300">
        Draft dibuat
      </Badge>
    );
  }

  if (normalized === "duplicate") {
    return (
      <Badge className="border-amber-700 bg-amber-950/40 text-amber-300">
        Duplikat
      </Badge>
    );
  }

  if (
    normalized === "manual_review" ||
    normalized === "failed"
  ) {
    return (
      <Badge className="border-red-700 bg-red-950/40 text-red-300">
        Perlu review
      </Badge>
    );
  }

  return (
    <Badge
      variant="outline"
      className="border-slate-600 text-slate-300"
    >
      {status || "Baru"}
    </Badge>
  );
}

async function readJson<T>(
  response: Response,
): Promise<T> {
  const payload = await response
    .json()
    .catch(() => ({}));

  if (!response.ok) {
    const apiError = payload as ApiError;
    throw new Error(
      apiError.error ||
        `HTTP ${response.status}`,
    );
  }

  return payload as T;
}

export default function InvoiceSourcesTab() {
  const {
    activeCompanyId,
    isConsolidated,
  } = useCompany();

  const [status, setStatus] =
    useState<GmailSourceStatus | null>(null);
  const [candidates, setCandidates] =
    useState<GmailCandidate[]>([]);
  const [organizationRules, setOrganizationRules] =
    useState<GmailOrganizationRule[]>([]);
  const [loading, setLoading] = useState(false);
  const [action, setAction] =
    useState<string | null>(null);
  const [error, setError] =
    useState<string | null>(null);
  const [notice, setNotice] =
    useState<string | null>(null);

  const companyId = useMemo(() => {
    if (isConsolidated) return null;
    const parsed = Number(activeCompanyId);
    return Number.isSafeInteger(parsed) &&
      parsed > 0
      ? parsed
      : null;
  }, [activeCompanyId, isConsolidated]);

  const callbackResult = useMemo(() => {
    const params = new URLSearchParams(
      window.location.search,
    );
    const gmail = params.get("gmail");
    const reason = params.get("reason");
    const organizer = params.get("organizer");

    if (gmail === "connected") {
      return {
        type: "success" as const,
        message:
          organizer === "partial"
            ? "Gmail berhasil dihubungkan, tetapi sebagian auto-label perlu diperiksa."
            : "Gmail berhasil dihubungkan. Auto-label aktif dan Sync Now siap membaca attachment invoice.",
      };
    }

    if (gmail === "error") {
      const reasonLabel: Record<string, string> = {
        invalid_state:
          "Sesi koneksi Google tidak valid atau sudah kedaluwarsa.",
        session_expired:
          "Sesi BizPortal sudah berakhir. Login ulang lalu hubungkan kembali.",
        actor_mismatch:
          "Akun BizPortal yang menyelesaikan koneksi berbeda dari akun yang memulainya.",
        company_scope_mismatch:
          "Perusahaan aktif tidak lagi sesuai dengan koneksi Gmail yang dimulai. Pilih perusahaan yang benar lalu hubungkan ulang.",
        access_denied:
          "Akses Gmail dibatalkan.",
        wrong_account:
          "Akun Google yang dipilih bukan travelincars01@gmail.com.",
        refresh_token_missing:
          "Google tidak memberikan refresh token. Hubungkan ulang dan setujui akses.",
        oauth_failed:
          "Proses OAuth Google gagal.",
        missing_code:
          "Kode otorisasi Google tidak diterima.",
      };

      return {
        type: "error" as const,
        message:
          reasonLabel[reason ?? ""] ||
          "Koneksi Gmail gagal. Silakan coba lagi.",
      };
    }

    return null;
  }, []);

  const loadData = useCallback(async () => {
    if (!companyId) {
      setStatus(null);
      setCandidates([]);
      setOrganizationRules([]);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const [
        statusResponse,
        candidateResponse,
        organizationResponse,
      ] = await Promise.all([
        fetch(
          `/api/recon-classification/invoice-sources/gmail/status?company_id=${companyId}`,
          { credentials: "include" },
        ),
        fetch(
          `/api/recon-classification/invoice-sources/gmail/candidates?company_id=${companyId}&limit=50`,
          { credentials: "include" },
        ),
        fetch(
          `/api/recon-classification/invoice-sources/gmail/organization-rules?company_id=${companyId}`,
          { credentials: "include" },
        ),
      ]);

      const nextStatus =
        await readJson<GmailSourceStatus>(
          statusResponse,
        );

      const candidatePayload =
        await readJson<{
          data: GmailCandidate[];
        }>(candidateResponse);

      const organizationPayload =
        await readJson<{
          data: GmailOrganizationRule[];
        }>(organizationResponse);

      setStatus(nextStatus);
      setCandidates(
        Array.isArray(candidatePayload.data)
          ? candidatePayload.data
          : [],
      );
      setOrganizationRules(
        Array.isArray(organizationPayload.data)
          ? organizationPayload.data
          : [],
      );
    } catch (err) {
      setStatus(null);
      setCandidates([]);
      setOrganizationRules([]);
      setError(
        err instanceof Error
          ? err.message
          : "Gagal membaca konfigurasi Gmail.",
      );
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const connect = async () => {
    if (!companyId) return;

    setAction("connect");
    setError(null);
    setNotice(null);

    try {
      const returnPath =
        `${window.location.pathname}?tab=invoice-sources`;

      const response = await fetch(
        "/api/recon-classification/invoice-sources/gmail/connect",
        {
          method: "POST",
          credentials: "include",
          headers: {
            "content-type":
              "application/json",
          },
          body: JSON.stringify({
            company_id: companyId,
            return_path: returnPath,
          }),
        },
      );

      const payload =
        await readJson<{ url: string }>(
          response,
        );

      window.location.assign(payload.url);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Gagal memulai koneksi Gmail.",
      );
      setAction(null);
    }
  };

  const sync = async () => {
    if (!companyId) return;

    setAction("sync");
    setError(null);
    setNotice(null);

    try {
      const response = await fetch(
        "/api/recon-classification/invoice-sources/gmail/sync",
        {
          method: "POST",
          credentials: "include",
          headers: {
            "content-type":
              "application/json",
          },
          body: JSON.stringify({
            company_id: companyId,
          }),
        },
      );

      const result =
        await readJson<SyncResult>(response);

      setNotice(
        `Sync selesai: ${result.attachmentsSeen} attachment dibaca, ${result.ready} siap dibuat draft, ${result.manualReview} perlu review, ${result.duplicates} duplikat, ${result.failed} gagal.`,
      );

      await loadData();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Gagal membaca Gmail.",
      );
    } finally {
      setAction(null);
    }
  };

  const importCandidate = async (
    candidate: GmailCandidate,
  ) => {
    if (!companyId) return;

    setAction(
      `import:${candidate.id}`,
    );
    setError(null);
    setNotice(null);

    try {
      const response = await fetch(
        `/api/recon-classification/invoice-sources/gmail/candidates/${candidate.id}/import`,
        {
          method: "POST",
          credentials: "include",
          headers: {
            "content-type":
              "application/json",
          },
          body: JSON.stringify({
            company_id: companyId,
          }),
        },
      );

      const result =
        await readJson<{
          ok: boolean;
          vendorInvoiceId: number;
          invoiceNumber?: string;
          existing?: boolean;
          message?: string;
        }>(response);

      setNotice(
        result.message ||
          "Draft Vendor Invoice berhasil dibuat.",
      );

      await loadData();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Gagal membuat draft Vendor Invoice.",
      );
    } finally {
      setAction(null);
    }
  };

  const applyOrganizer = async () => {
    if (!companyId) return;

    setAction("organizer");
    setError(null);
    setNotice(null);

    try {
      const response = await fetch(
        "/api/recon-classification/invoice-sources/gmail/organization-rules/apply",
        {
          method: "POST",
          credentials: "include",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            company_id: companyId,
          }),
        },
      );

      const result = await readJson<{
        ok: boolean;
        total: number;
        active: number;
        createdLabels: number;
        createdFilters: number;
        failed: number;
        senderScannedMessages?: number;
        senderGroups?: number;
        senderCreatedLabels?: number;
        senderCreatedFilters?: number;
        senderLabeledMessages?: number;
      }>(response);

      setNotice(
        result.failed > 0
          ? `Auto-label diterapkan sebagian. Pengirim terdeteksi: ${result.senderGroups ?? 0}; periksa rule yang gagal.`
          : `Auto-label selesai: ${result.senderGroups ?? 0} kelompok pengirim, ${result.senderLabeledMessages ?? 0} email lama diberi label, ${result.senderCreatedLabels ?? 0} label baru, dan ${result.senderCreatedFilters ?? 0} filter baru.`,
      );
      await loadData();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Gagal menerapkan auto-label Gmail.",
      );
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
    setNotice(null);

    try {
      const response = await fetch(
        "/api/recon-classification/invoice-sources/gmail/disconnect",
        {
          method: "POST",
          credentials: "include",
          headers: {
            "content-type":
              "application/json",
          },
          body: JSON.stringify({
            company_id: companyId,
          }),
        },
      );

      await readJson(response);
      setNotice(
        "Koneksi Gmail berhasil diputus.",
      );
      await loadData();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Gagal memutus koneksi Gmail.",
      );
    } finally {
      setAction(null);
    }
  };

  if (isConsolidated) {
    return (
      <div className="rounded-lg border border-amber-700/50 bg-amber-950/20 p-4 text-sm text-amber-200">
        Pilih satu perusahaan terlebih dahulu.
        Sumber invoice Gmail disimpan per
        perusahaan, bukan pada mode konsolidasi.
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
          {callbackResult.type ===
          "success" ? (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          ) : (
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          )}
          <span>
            {callbackResult.message}
          </span>
        </div>
      )}

      {notice && (
        <div className="flex items-start gap-2 rounded-lg border border-emerald-700/50 bg-emerald-950/20 p-4 text-sm text-emerald-200">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{notice}</span>
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
                Baca email dan attachment invoice
                untuk Match INV, serta kelola label
                Gmail tanpa mengirim atau menghapus
                email.
              </p>
            </div>

            {status?.connected ? (
              <Badge className="border-emerald-700 bg-emerald-950/40 text-emerald-300">
                Connected
              </Badge>
            ) : (
              <Badge
                variant="outline"
                className="border-slate-600 text-slate-300"
              >
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
                  <p className="text-xs uppercase tracking-wide text-slate-500">
                    Akun Gmail
                  </p>
                  <p className="mt-1 text-sm font-semibold text-white">
                    {status?.connectedEmail ||
                      status?.expectedEmail ||
                      "travelincars01@gmail.com"}
                  </p>
                </div>

                <div className="rounded-lg border border-slate-700 bg-slate-950/40 p-3">
                  <p className="text-xs uppercase tracking-wide text-slate-500">
                    Akses
                  </p>
                  <p className="mt-1 flex items-center gap-1.5 text-sm font-semibold text-white">
                    <ShieldCheck className="h-4 w-4 text-emerald-400" />
                    Baca email + kelola label/filter
                  </p>
                </div>

                <div className="rounded-lg border border-slate-700 bg-slate-950/40 p-3">
                  <p className="text-xs uppercase tracking-wide text-slate-500">
                    Last Sync
                  </p>
                  <p className="mt-1 text-sm font-semibold text-white">
                    {formatDateTime(
                      status?.lastSyncAt ?? null,
                    )}
                  </p>
                </div>

                <div className="rounded-lg border border-slate-700 bg-slate-950/40 p-3">
                  <p className="text-xs uppercase tracking-wide text-slate-500">
                    Attachment Terakhir
                  </p>
                  <p className="mt-1 text-sm font-semibold text-white">
                    {status?.lastSyncCount ?? 0} file
                  </p>
                </div>
              </div>

              {!status?.oauthConfigured && (
                <div className="rounded-lg border border-amber-700/50 bg-amber-950/20 p-4 text-sm text-amber-200">
                  Google OAuth belum terbaca oleh
                  server BizPortal. Sistem sekarang
                  mencoba environment terlebih dahulu
                  lalu App Config. Callback yang harus
                  terdaftar pada Google OAuth:
                  <code className="mt-2 block break-all rounded bg-black/30 p-2 text-xs text-amber-100">
                    {status?.redirectUri ||
                      "Callback URI belum tersedia."}
                  </code>
                </div>
              )}

              {status?.oauthConfigured &&
                !status?.aiConfigured && (
                  <div className="rounded-lg border border-amber-700/50 bg-amber-950/20 p-4 text-sm text-amber-200">
                    Gmail OAuth sudah siap, tetapi
                    OpenAI OCR belum terbaca. Sinkron
                    attachment membutuhkan
                    OPENAI_API_KEY pada server atau App
                    Config.
                  </div>
                )}

              <div className="flex flex-wrap gap-2">
                {!status?.connected ? (
                  <Button
                    onClick={() =>
                      void connect()
                    }
                    disabled={
                      !companyId ||
                      !status?.oauthConfigured ||
                      action !== null
                    }
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
                      disabled={
                        action !== null ||
                        !status.aiConfigured
                      }
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
                      onClick={() => void connect()}
                      disabled={
                        action !== null ||
                        !status.oauthConfigured
                      }
                      className="gap-2 border-slate-600"
                    >
                      {action === "connect" ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Link2 className="h-4 w-4" />
                      )}
                      Reconnect Gmail
                    </Button>

                    <Button
                      variant="outline"
                      onClick={() =>
                        void disconnect()
                      }
                      disabled={action !== null}
                      className="gap-2 border-slate-600"
                    >
                      {action ===
                      "disconnect" ? (
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
                  onClick={() =>
                    void loadData()
                  }
                  disabled={
                    loading || action !== null
                  }
                  className="gap-2 text-slate-300"
                >
                  <RefreshCw
                    className={`h-4 w-4 ${loading ? "animate-spin" : ""}`}
                  />
                  Refresh Status
                </Button>
              </div>

              <div className="border-t border-slate-800 pt-4 text-xs leading-5 text-slate-500">
                Koneksi tidak meminta password Gmail
                dan tidak dapat mengirim atau menghapus
                email. BizPortal dapat membaca email,
                membuat label, menempelkan label pada
                email yang sudah ada, dan membuat filter
                Gmail untuk merapikan email masuk. Attachment
                invoice tetap melalui OCR, kandidat,
                review, dan tidak pernah langsung
                memposting jurnal.
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card className="border-slate-700 bg-slate-900/70">
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-base text-white">
                <Mail className="h-4 w-4 text-orange-400" />
                Pengelompokan Gmail Otomatis
              </CardTitle>
              <p className="mt-1 text-sm text-slate-400">
                Email dikelompokkan berdasarkan nama pengirim. Email lama dibackfill dan email baru dari pengirim yang sama otomatis masuk ke label yang sesuai, tanpa dipindahkan dari Inbox.
              </p>
            </div>
            <Badge
              variant="outline"
              className="border-slate-600 text-slate-300"
            >
              {status?.organizerActiveCount ?? 0}/{status?.organizerRuleCount ?? 0} aktif
            </Badge>
          </div>
        </CardHeader>

        <CardContent className="space-y-3">
          {organizationRules.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-700 p-4 text-sm text-slate-400">
              Belum ada rule pengelompokan Gmail.
            </div>
          ) : (
            <div className="space-y-2">
              {organizationRules.map((rule) => (
                <div
                  key={rule.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-800 bg-slate-950/30 p-3"
                >
                  <div>
                    <p className="text-sm font-semibold text-white">
                      {rule.labelName}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      Pengirim: {rule.fromPattern || "—"}
                      {rule.subjectPattern
                        ? ` · Subject: ${rule.subjectPattern}`
                        : ""}
                    </p>
                    {rule.lastError && (
                      <p className="mt-1 text-xs text-red-400">
                        {rule.lastError}
                      </p>
                    )}
                  </div>
                  <Badge
                    className={
                      rule.status === "active"
                        ? "border-emerald-700 bg-emerald-950/40 text-emerald-300"
                        : rule.status === "error"
                          ? "border-red-700 bg-red-950/40 text-red-300"
                          : "border-slate-600 bg-slate-900 text-slate-300"
                    }
                  >
                    {rule.status === "active"
                      ? "Aktif"
                      : rule.status === "error"
                        ? "Error"
                        : "Menunggu Connect"}
                  </Badge>
                </div>
              ))}
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => void applyOrganizer()}
              disabled={!status?.connected || action !== null}
              className="gap-2"
            >
              {action === "organizer" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              Terapkan Auto Label
            </Button>
          </div>

          <p className="text-xs leading-5 text-slate-500">
            Contoh: email dari Hostinger akan masuk ke label
            <span className="font-semibold text-slate-300"> Hostinger</span>.
            BizPortal juga membuat label untuk pengirim lain yang ditemukan. Pengirim baru akan dideteksi otomatis secara berkala.
          </p>
        </CardContent>
      </Card>

      <Card className="border-slate-700 bg-slate-900/70">
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-base text-white">
                <FileText className="h-4 w-4 text-orange-400" />
                Kandidat Invoice dari Gmail
              </CardTitle>
              <p className="mt-1 text-sm text-slate-400">
                Attachment yang sudah dibaca OCR.
                Kandidat siap dapat dibuat menjadi
                Draft Vendor Invoice.
              </p>
            </div>

            <Badge
              variant="outline"
              className="border-slate-600 text-slate-300"
            >
              {candidates.length} kandidat
            </Badge>
          </div>
        </CardHeader>

        <CardContent>
          {loading &&
          candidates.length === 0 ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-slate-400">
              <Loader2 className="h-4 w-4 animate-spin" />
              Memuat kandidat invoice...
            </div>
          ) : candidates.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-700 px-4 py-10 text-center">
              <FileText className="mx-auto mb-3 h-7 w-7 text-slate-600" />
              <p className="text-sm font-medium text-slate-300">
                Belum ada kandidat invoice Gmail
              </p>
              <p className="mt-1 text-xs text-slate-500">
                Setelah Gmail terhubung, klik Sync
                Now untuk membaca email invoice dan
                attachment PDF/gambar.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-slate-800">
              <table className="w-full min-w-[1050px] text-sm">
                <thead className="bg-slate-950/70 text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-3 py-3 text-left font-medium">
                      Tanggal Invoice
                    </th>
                    <th className="px-3 py-3 text-left font-medium">
                      Jatuh Tempo
                    </th>
                    <th className="px-3 py-3 text-left font-medium">
                      Pengirim / File
                    </th>
                    <th className="px-3 py-3 text-left font-medium">
                      Vendor
                    </th>
                    <th className="px-3 py-3 text-left font-medium">
                      No. Invoice
                    </th>
                    <th className="px-3 py-3 text-right font-medium">
                      Total
                    </th>
                    <th className="px-3 py-3 text-center font-medium">
                      OCR
                    </th>
                    <th className="px-3 py-3 text-left font-medium">
                      Status
                    </th>
                    <th className="px-3 py-3 text-right font-medium">
                      Aksi
                    </th>
                  </tr>
                </thead>

                <tbody className="divide-y divide-slate-800">
                  {candidates.map(
                    (candidate) => {
                      const importAction =
                        `import:${candidate.id}`;
                      const canImport =
                        candidate.status ===
                          "ready" &&
                        !candidate.vendorInvoiceId;

                      return (
                        <tr
                          key={candidate.id}
                          className="bg-slate-900/20 text-slate-300 hover:bg-slate-800/30"
                        >
                          <td className="whitespace-nowrap px-3 py-3 text-xs text-slate-400">
                            {formatInvoiceDate(candidate.invoiceDate)}
                          </td>
                          <td className="whitespace-nowrap px-3 py-3 text-xs text-slate-400">
                            {formatInvoiceDate(candidate.dueDate)}
                          </td>

                          <td className="max-w-[260px] px-3 py-3">
                            <p className="truncate text-xs font-medium text-slate-200">
                              {candidate.senderName ||
                                candidate.senderEmail ||
                                "—"}
                            </p>
                            <p className="mt-1 truncate text-xs text-slate-500">
                              {candidate.fileName}
                            </p>
                          </td>

                          <td className="max-w-[220px] px-3 py-3">
                            <p className="truncate text-sm font-medium text-white">
                              {candidate.vendorName ||
                                "—"}
                            </p>
                            {candidate.error && (
                              <p
                                className="mt-1 max-w-[220px] truncate text-xs text-red-400"
                                title={
                                  candidate.error
                                }
                              >
                                {candidate.error}
                              </p>
                            )}
                          </td>

                          <td className="whitespace-nowrap px-3 py-3 font-medium text-slate-200">
                            {candidate.invoiceNumber ||
                              "—"}
                          </td>

                          <td className="whitespace-nowrap px-3 py-3 text-right font-semibold text-white">
                            {formatMoney(
                              candidate.total,
                              candidate.currency ||
                                "IDR",
                            )}
                          </td>

                          <td className="whitespace-nowrap px-3 py-3 text-center">
                            <span
                              className={
                                (candidate.confidence ??
                                  0) >= 0.8
                                  ? "text-emerald-300"
                                  : (candidate.confidence ??
                                        0) >= 0.65
                                    ? "text-amber-300"
                                    : "text-slate-400"
                              }
                            >
                              {formatConfidence(
                                candidate.confidence,
                              )}
                            </span>
                          </td>

                          <td className="whitespace-nowrap px-3 py-3">
                            {statusBadge(
                              candidate.status,
                            )}
                          </td>

                          <td className="whitespace-nowrap px-3 py-3 text-right">
                            {candidate.vendorInvoiceId ? (
                              <Button
                                size="sm"
                                variant="outline"
                                className="gap-1.5 border-slate-600"
                                onClick={() =>
                                  window.location.assign(
                                    `/purchase/vendor-invoices/${candidate.vendorInvoiceId}`,
                                  )
                                }
                              >
                                <ExternalLink className="h-3.5 w-3.5" />
                                Buka Invoice
                              </Button>
                            ) : canImport ? (
                              <Button
                                size="sm"
                                className="gap-1.5"
                                disabled={
                                  action !== null
                                }
                                onClick={() =>
                                  void importCandidate(
                                    candidate,
                                  )
                                }
                              >
                                {action ===
                                importAction ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <FileText className="h-3.5 w-3.5" />
                                )}
                                Buat Draft
                              </Button>
                            ) : (
                              <span className="text-xs text-slate-500">
                                {candidate.status ===
                                "manual_review"
                                  ? "Review OCR"
                                  : "—"}
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    },
                  )}
                </tbody>
              </table>
            </div>
          )}

          <div className="mt-4 rounded-lg border border-slate-800 bg-slate-950/30 p-3 text-xs leading-5 text-slate-500">
            Alur aman: Gmail → OCR → Kandidat →
            Buat Draft Vendor Invoice → Finance
            Review → Posting. Hanya Vendor Invoice
            berstatus posted yang kemudian dapat
            ditawarkan sebagai kandidat Match INV
            pada rekonsiliasi bank.
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
