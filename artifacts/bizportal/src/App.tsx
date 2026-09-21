import React from "react";
import { Router as WouterRouter, Redirect } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SupabaseAuthProvider, useSupabaseAuth } from "@/contexts/SupabaseAuthContext";
import { LanguageProvider } from "@/contexts/LanguageContext";
import { CompanyProvider } from "@/contexts/CompanyContext";
import { useGetCurrentUser, getGetCurrentUserQueryKey } from "@shared/api-client-react";
import { AppRoutes } from "@/routes";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { OrderNotificationsProvider } from "@/contexts/OrderNotificationsContext";
import { BIZ_ASSETS } from "@/lib/staticAssets";





const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 2 * 60 * 1000,
      gcTime: 10 * 60 * 1000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});
const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
const appRootPath = basePath ? `${basePath}/` : "/";

const ROLE_CACHE_KEY = "biz_user_role_v1";
function readRoleCache() {
  try {
    return sessionStorage.getItem(ROLE_CACHE_KEY);
  } catch {
    return null;
  }
}
function writeRoleCache(role: string | null) {
  try {
    if (role) sessionStorage.setItem(ROLE_CACHE_KEY, role);
    else sessionStorage.removeItem(ROLE_CACHE_KEY);
  } catch {}
}

function roleToPath(role?: string | null) {
  switch (role) {
    case "admin":
      return "/dashboard";
    case "ecommerce":
      return "/ecommerce";
    case "trading":
      return "/trading";
    case "logistics":
      return "/logistics";
    default:
      return "/welcome";
  }
}
function LoadingSpinner() {
  return (
    <div className="flex h-screen items-center justify-center bg-slate-950">
      <div className="h-8 w-8 animate-spin rounded-full border-4 border-indigo-500 border-t-transparent" />
    </div>
  );
}

function ApiPreparingScreen() {
  const { isApiAvailable, apiReadinessError, retryApiReadiness } = useSupabaseAuth();
  const title = isApiAvailable ? "Menyiapkan BizPortal" : "API BizPortal tidak terjangkau";
  const description = isApiAvailable
    ? "Server sedang menyelesaikan persiapan database. Halaman login akan tersedia otomatis setelah API siap."
    : "Browser belum dapat mencapai proses API melalui proxy. Sistem akan mencoba kembali otomatis.";
  const defaultMessage = isApiAvailable
    ? "Persiapan masih berjalan. Anda tidak perlu memuat ulang halaman."
    : "API belum merespons. Pastikan workflow API berjalan; sistem akan mencoba kembali.";

  return (
    <div
      className="flex min-h-screen items-center justify-center bg-slate-950 px-6 text-white"
      role="status"
      aria-live="polite"
    >
      <div className="flex w-full max-w-md flex-col items-center gap-5 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-indigo-600/20 ring-1 ring-indigo-500/40">
          <div className="h-7 w-7 animate-spin rounded-full border-4 border-indigo-300 border-t-transparent" />
        </div>
        <div className="space-y-2">
          <h1 className="text-xl font-semibold">{title}</h1>
          <p className="text-sm leading-6 text-slate-400">{description}</p>
        </div>
        <div className="w-full rounded-lg border border-slate-800 bg-slate-900/70 px-4 py-3 text-left text-xs text-slate-400">
          {apiReadinessError ?? defaultMessage}
        </div>
        <button
          type="button"
          onClick={retryApiReadiness}
          className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200 transition-colors hover:border-indigo-500 hover:bg-indigo-500/10"
        >
          Coba cek sekarang
        </button>
      </div>
    </div>
  );
}

const IS_DEV = import.meta.env.DEV;

type DevUser = { id: string; email: string; firstName: string | null; lastName: string | null; role: string | null };

const ROLE_LABELS: Record<string, string> = {
  admin: "Admin",
  ecommerce: "Ecommerce",
  trading: "Trading",
  logistics: "Logistics",
};

function DevLoginSection() {
  const [users, setUsers] = React.useState<DevUser[]>([]);
  const [devEmail, setDevEmail] = React.useState("");
  const [mode, setMode] = React.useState<"pick" | "manual">("pick");
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    // Keep this development-only convenience request off the critical path
    // so the login form appears while the API is still warming up.
    const timer = window.setTimeout(() => {
      fetch("/api/auth/dev-users", { credentials: "include" })
        .then((r) => r.ok ? r.json() : { users: [] })
        .then((d: { users: DevUser[] }) => {
          setUsers(d.users ?? []);
          if (d.users?.length > 0) {
            setDevEmail(d.users[0].email ?? "");
          }
        })
        .catch(() => setMode("manual"));
    }, 800);
    return () => window.clearTimeout(timer);
  }, []);

  const grouped = React.useMemo(() => {
    const map: Record<string, DevUser[]> = {};
    for (const u of users) {
      const r = u.role ?? "other";
      if (!map[r]) map[r] = [];
      map[r].push(u);
    }
    return map;
  }, [users]);

  async function handleDevLogin(e: React.FormEvent) {
    e.preventDefault();
    if (!devEmail || loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/dev-login", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `email=${encodeURIComponent(devEmail)}`,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        setError(data.error ?? `Login gagal (${res.status})`);
        return;
      }
      const selectedUser = users.find((user) => user.email === devEmail);
      if (selectedUser?.role) writeRoleCache(selectedUser.role);
      else sessionStorage.removeItem(ROLE_CACHE_KEY);
      window.location.href = appRootPath;
    } catch {
      setError("Gagal terhubung ke server. Pastikan API Server berjalan.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <div className="flex items-center gap-3">
        <div className="flex-1 h-px bg-slate-700" />
        <span className="text-xs text-amber-400 font-mono">DEV ONLY</span>
        <div className="flex-1 h-px bg-slate-700" />
      </div>
      <form onSubmit={handleDevLogin} className="flex flex-col gap-2">
        {mode === "pick" && users.length > 0 ? (
          <>
            <select
              value={devEmail}
              onChange={(e) => setDevEmail(e.target.value)}
              className="rounded-lg bg-slate-800 border border-amber-600/40 px-3 py-2.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-amber-500 cursor-pointer"
            >
              {Object.entries(grouped).map(([role, roleUsers]) => (
                <optgroup key={role} label={`— ${ROLE_LABELS[role] ?? role} —`}>
                  {roleUsers.map((u) => {
                    const name = [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email;
                    return (
                      <option key={u.id} value={u.email ?? ""}>
                        {name} ({u.email})
                      </option>
                    );
                  })}
                </optgroup>
              ))}
            </select>
            <button
              type="button"
              onClick={() => setMode("manual")}
              className="text-xs text-slate-500 hover:text-slate-400 text-right -mt-1"
            >
              + email lain
            </button>
          </>
        ) : (
          <>
            <input
              type="email"
              placeholder="Email (dev bypass)"
              value={devEmail}
              onChange={(e) => setDevEmail(e.target.value)}
              required
              className="rounded-lg bg-slate-800 border border-amber-600/40 px-4 py-2.5 text-sm text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-amber-500"
            />
            {users.length > 0 && (
              <button
                type="button"
                onClick={() => { setMode("pick"); setDevEmail(users[0].email ?? ""); }}
                className="text-xs text-slate-500 hover:text-slate-400 text-right -mt-1"
              >
                ← pilih dari daftar
              </button>
            )}
          </>
        )}
        {error && (
          <p className="text-xs text-red-400 text-center">{error}</p>
        )}
        <button
          type="submit"
          disabled={loading}
          className="rounded-lg bg-amber-600 px-6 py-2.5 text-sm font-medium text-white shadow hover:bg-amber-500 active:scale-95 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? "Logging in…" : "Dev Login (tanpa Google)"}
        </button>
      </form>
    </>
  );
}

function WaLoginSection() {
  const { loginWithWA } = useSupabaseAuth();
  const [phone, setPhone] = React.useState("");
  const [code, setCode] = React.useState("");
  const [otpSent, setOtpSent] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [countdown, setCountdown] = React.useState(0);

  React.useEffect(() => {
    if (countdown <= 0) return;
    const t = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [countdown]);

  async function sendOtp() {
    if (!phone || loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/wa-otp/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone }),
      });
      const data = await res.json() as {
        ok?: boolean;
        message?: string;
        error?: string;
      };
      if (!res.ok) {
        setError(data.message ?? data.error ?? "Gagal mengirim OTP");
        return;
      }
      setOtpSent(true);
      setCountdown(60);
    } catch {
      setError("Gagal terhubung ke server");
    } finally {
      setLoading(false);
    }
  }

  async function verifyOtp(e: React.FormEvent) {
    e.preventDefault();
    if (!code || loading) return;
    setLoading(true);
    setError(null);
    const result = await loginWithWA(phone, code);
    if (result.error) { setError(result.error); setLoading(false); return; }
    window.location.href = appRootPath;
  }

  return (
    <div className="flex flex-col gap-3">
      {!otpSent ? (
        <div className="flex gap-2">
          <input
            type="tel"
            placeholder="No. WhatsApp (cth: 08123456789)"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className="flex-1 rounded-lg bg-slate-800 border border-slate-700 px-3 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-green-500"
          />
          <button
            onClick={sendOtp}
            disabled={loading || !phone}
            className="rounded-lg bg-green-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-green-500 active:scale-95 transition-all disabled:opacity-50 whitespace-nowrap"
          >
            {loading ? "..." : "Kirim OTP"}
          </button>
        </div>
      ) : (
        <form onSubmit={verifyOtp} className="flex flex-col gap-2">
          <p className="text-xs text-slate-400 text-center">
            Kode OTP dikirim ke WhatsApp <span className="text-white font-mono">{phone}</span>
          </p>
          <input
            type="text"
            inputMode="numeric"
            placeholder="Masukkan 6 digit kode OTP"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            maxLength={6}
            autoFocus
            className="rounded-lg bg-slate-800 border border-green-600/40 px-4 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-green-500 text-center tracking-widest font-mono text-lg"
          />
          <button
            type="submit"
            disabled={loading || code.length !== 6}
            className="rounded-lg bg-green-600 px-6 py-2.5 text-sm font-medium text-white shadow hover:bg-green-500 active:scale-95 transition-all disabled:opacity-50"
          >
            {loading ? "Memverifikasi..." : "Masuk"}
          </button>
          <div className="flex justify-between text-xs text-slate-500">
            <button type="button" onClick={() => { setOtpSent(false); setCode(""); setError(null); }} className="hover:text-slate-300">
              ← Ganti nomor
            </button>
            {countdown > 0 ? (
              <span>Kirim ulang ({countdown}s)</span>
            ) : (
              <button type="button" onClick={sendOtp} disabled={loading} className="hover:text-slate-300">
                Kirim ulang OTP
              </button>
            )}
          </div>
        </form>
      )}
      {error && <p className="text-xs text-red-400 text-center">{error}</p>}
    </div>
  );
}

function EmailLoginSection() {
  const { signInWithEmail, sendEmailOtp, verifyEmailOtp } = useSupabaseAuth();
  const [mode, setMode] = React.useState<"password" | "otp">("password");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [code, setCode] = React.useState("");
  const [otpSent, setOtpSent] = React.useState(false);
  const [countdown, setCountdown] = React.useState(0);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (countdown <= 0) return;
    const timer = window.setTimeout(() => setCountdown((value) => value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [countdown]);

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password || loading) return;
    setLoading(true);
    setError(null);
    const result = await signInWithEmail(email, password);
    if (result.error) {
      setError(result.error);
      setLoading(false);
    } else {
      writeRoleCache("admin");
      window.location.href = appRootPath;
    }
  };

  const handleSendOtp = async () => {
    if (!email.trim() || loading) return;
    setLoading(true);
    setError(null);
    const result = await sendEmailOtp(email);
    if (result.error) {
      setError(result.error);
    } else {
      setOtpSent(true);
      setCode("");
      setCountdown(60);
    }
    setLoading(false);
  };

  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || code.length !== 6 || loading) return;
    setLoading(true);
    setError(null);
    const result = await verifyEmailOtp(email, code);
    if (result.error) {
      setError(result.error);
      setLoading(false);
      return;
    }
    writeRoleCache("admin");
    window.location.href = appRootPath;
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex rounded-lg bg-slate-800/80 p-1 gap-1">
        <button
          type="button"
          onClick={() => { setMode("password"); setOtpSent(false); setError(null); }}
          className={`flex-1 rounded-md py-2 text-xs font-medium transition-all ${mode === "password" ? "bg-indigo-600 text-white shadow" : "text-slate-400 hover:text-white"}`}
        >
          Password
        </button>
        <button
          type="button"
          onClick={() => { setMode("otp"); setError(null); }}
          className={`flex-1 rounded-md py-2 text-xs font-medium transition-all ${mode === "otp" ? "bg-indigo-600 text-white shadow" : "text-slate-400 hover:text-white"}`}
        >
          OTP Email
        </button>
      </div>
      <input
        type="email"
        aria-label="Email admin"
        placeholder="Email admin"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        required
        autoComplete="email"
        className="rounded-lg bg-slate-800/70 border border-slate-700 px-3 py-2.5 text-sm text-slate-300 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 read-only:cursor-not-allowed read-only:opacity-70"
      />
      {mode === "password" ? (
        <form onSubmit={handlePasswordSubmit} className="flex flex-col gap-3">
          <input
            type="password"
            aria-label="Password admin"
            placeholder="Password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            autoComplete="current-password"
            className="rounded-lg bg-slate-800/70 border border-slate-700 px-3 py-2.5 text-sm text-slate-300 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          {error && <p className="text-xs text-red-400 text-center">{error}</p>}
          <button
            type="submit"
            disabled={loading || !email.trim() || !password}
            className="rounded-lg bg-indigo-600 px-6 py-2.5 text-sm font-medium text-white shadow hover:bg-indigo-500 active:scale-95 transition-all disabled:opacity-50"
          >
            {loading ? "Memproses..." : "Masuk"}
          </button>
        </form>
      ) : !otpSent ? (
        <>
          <p className="text-xs leading-5 text-slate-400 text-center">
            Kode sekali pakai akan dikirim ke email admin dan berlaku selama 5 menit.
          </p>
          {error && <p className="text-xs text-red-400 text-center">{error}</p>}
          <button
            type="button"
            onClick={handleSendOtp}
            disabled={loading || !email.trim()}
            className="rounded-lg bg-indigo-600 px-6 py-2.5 text-sm font-medium text-white shadow hover:bg-indigo-500 active:scale-95 transition-all disabled:opacity-50"
          >
            {loading ? "Mengirim..." : "Kirim OTP ke Email"}
          </button>
        </>
      ) : (
        <form onSubmit={handleVerifyOtp} className="flex flex-col gap-3">
          <p className="text-xs leading-5 text-slate-400 text-center">
            Masukkan kode 6 digit dari email admin. Kode berlaku 5 menit.
          </p>
          <input
            type="text"
            inputMode="numeric"
            aria-label="Kode OTP email"
            placeholder="Masukkan 6 digit OTP"
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
            required
            maxLength={6}
            autoComplete="one-time-code"
            autoFocus
            className="rounded-lg bg-slate-800/70 border border-indigo-500/50 px-4 py-2.5 text-center text-lg tracking-[0.35em] font-mono text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          {error && <p className="text-xs text-red-400 text-center">{error}</p>}
          <button
            type="submit"
            disabled={loading || code.length !== 6}
            className="rounded-lg bg-indigo-600 px-6 py-2.5 text-sm font-medium text-white shadow hover:bg-indigo-500 active:scale-95 transition-all disabled:opacity-50"
          >
            {loading ? "Memverifikasi..." : "Verifikasi OTP"}
          </button>
          <div className="flex justify-between text-xs text-slate-500">
            <button type="button" onClick={() => { setOtpSent(false); setCode(""); setError(null); }} className="hover:text-slate-300">
              ← Ganti email
            </button>
            {countdown > 0 ? (
              <span>Kirim ulang ({countdown}s)</span>
            ) : (
              <button type="button" onClick={handleSendOtp} disabled={loading} className="hover:text-slate-300">
                Kirim ulang OTP
              </button>
            )}
          </div>
        </form>
      )}
    </div>
  );
}

function LoginScreen() {
  const [loginMode, setLoginMode] = React.useState<"email" | "wa">("email");

  return (
    <div className="flex h-screen flex-col items-center justify-center gap-6 bg-slate-950 text-white">
      <div className="flex flex-col items-center gap-2">
        <img
          src={BIZ_ASSETS.logo}
          alt="CST"
          className="h-14 w-14 object-contain"
        />
        <h1 className="text-2xl font-semibold tracking-tight">BizPortal</h1>
        <p className="text-sm text-slate-400">
          Sistem ERP Internal B2B Marketplace and Logistic
        </p>
      </div>

      {/* Tab switcher */}
      <div className="flex rounded-lg bg-slate-800 p-1 gap-1 w-72">
        <button
          onClick={() => setLoginMode("email")}
          className={`flex-1 rounded-md py-2 text-xs font-medium transition-all ${loginMode === "email" ? "bg-indigo-600 text-white shadow" : "text-slate-400 hover:text-white"}`}
        >
          ✉️ Email
        </button>
        <button
          onClick={() => setLoginMode("wa")}
          className={`flex-1 rounded-md py-2 text-xs font-medium transition-all ${loginMode === "wa" ? "bg-green-600 text-white shadow" : "text-slate-400 hover:text-white"}`}
        >
          📱 WhatsApp
        </button>
      </div>

      <div className="flex flex-col gap-3 w-72">
        {loginMode === "email" ? <EmailLoginSection /> : <WaLoginSection />}
      </div>

      {IS_DEV && (
        <div className="w-72">
          <DevLoginSection />
        </div>
      )}
    </div>
  );
}

function AuthRouteGuard() {
  const { user, isAuthenticated, isLoading, isApiAvailable } = useSupabaseAuth();
  const cachedRole = readRoleCache();
  const { data: dbUser, isLoading: dbLoading } = useGetCurrentUser({
    query: {
      enabled: isAuthenticated && isApiAvailable,
      queryKey: getGetCurrentUserQueryKey(),
      staleTime: 5 * 60 * 1000,
      retry: 1,
    },
  });
  React.useEffect(() => {
    if (dbUser?.role) writeRoleCache(dbUser.role);
  }, [dbUser?.role]);
  if (!isApiAvailable) return <ApiPreparingScreen />;
  if (isLoading) return <LoadingSpinner />;
  if (!isAuthenticated) {
    writeRoleCache(null);
    return <LoginScreen />;
  }
  // A cached role is enough to choose the first route. The user query still
  // runs in the background and will correct the route if the role changed,
  // but the app no longer shows a full-screen spinner while it waits.
  if (dbLoading && !cachedRole && !user?.role) return <LoadingSpinner />;
  return <Redirect to={roleToPath(dbUser?.role ?? cachedRole ?? user?.role)} />;
}

function AppContent() {
  const { isApiAvailable, isApiReady, isAuthenticated, isLoading } = useSupabaseAuth();

  React.useEffect(() => {
    const legacyPrefix = "/bizportal";
    if (
      window.location.pathname === legacyPrefix ||
      window.location.pathname.startsWith(`${legacyPrefix}/`)
    ) {
      const rootPath = window.location.pathname.slice(legacyPrefix.length) || "/";
      window.location.replace(
        `${rootPath}${window.location.search}${window.location.hash}`,
      );
    }
  }, []);

  // The login page must not depend on the long-running readiness poll. A
  // logged-out user can see the form immediately and receive a normal request
  // error if the API is unavailable. Only authenticated users wait before
  // route/provider side effects are mounted.
  if (IS_DEV && isLoading) return <LoadingSpinner />;
  if (!isAuthenticated) return <LoginScreen />;
  if (!isApiAvailable || !isApiReady) return <ApiPreparingScreen />;

  return (
    <LanguageProvider>
      <CompanyProvider>
        <OrderNotificationsProvider>
          <TooltipProvider>
            <Router />
            <Toaster />
          </TooltipProvider>
        </OrderNotificationsProvider>
      </CompanyProvider>
    </LanguageProvider>
  );
}

function Router() {
  return (
    <WouterRouter base={basePath}>
      <AppRoutes rootGuard={AuthRouteGuard} />
    </WouterRouter>
  );
}

export default function App() {
  return (
    <ErrorBoundary label="App">
      <QueryClientProvider client={queryClient}>
        <SupabaseAuthProvider>
          <AppContent />
        </SupabaseAuthProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
