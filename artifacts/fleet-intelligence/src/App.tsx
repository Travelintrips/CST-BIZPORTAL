import React from "react";
import { Redirect, Route, Switch } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster, toast } from "sonner";

const Dashboard = React.lazy(() => import("@/pages/index"));
const Upload = React.lazy(() => import("@/pages/upload"));
const Drivers = React.lazy(() => import("@/pages/drivers"));
const DriverDetail = React.lazy(() => import("@/pages/driver-detail"));
const Vehicles = React.lazy(() => import("@/pages/vehicles"));
const Transactions = React.lazy(() => import("@/pages/transactions"));
const Outstanding = React.lazy(() => import("@/pages/outstanding"));
const Analytics = React.lazy(() => import("@/pages/analytics"));
const Alerts = React.lazy(() => import("@/pages/alerts"));
const Accounting = React.lazy(() => import("@/pages/accounting"));
const Validation = React.lazy(() => import("@/pages/validation"));
const Expenses = React.lazy(() => import("@/pages/expenses"));
const ControlCenter = React.lazy(() => import("@/pages/control-center"));
const DLQ = React.lazy(() => import("@/pages/dlq"));
const Ledger = React.lazy(() => import("@/pages/ledger-explorer"));
const Reconciliation = React.lazy(() => import("@/pages/reconciliation"));
const Pipeline = React.lazy(() => import("@/pages/pipeline-monitor"));
const DriverMacet = React.lazy(() => import("@/pages/driver-macet"));
const Macet = React.lazy(() => import("@/pages/macet"));
const CashPayments = React.lazy(() => import("@/pages/cash-payments"));

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000, refetchOnWindowFocus: false } },
});

function Fallback() {
  return <div className="min-h-screen bg-slate-950 text-slate-300 flex items-center justify-center">Memuat Fleet Intelligence…</div>;
}

type SessionUser = { id?: string; email?: string; role?: string; companyId?: number | string };

function LoginScreen({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [email,setEmail]=React.useState("");
  const [password,setPassword]=React.useState("");
  const [loading,setLoading]=React.useState(false);
  const devLoginEnabled=String(import.meta.env.VITE_ENABLE_DEV_LOGIN ?? "").toLowerCase()==="true";

  async function login(path:string, body:Record<string,string>) {
    setLoading(true);
    try {
      const response=await fetch(path,{
        method:"POST",
        credentials:"include",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify(body),
      });
      const payload=await response.json().catch(()=>({})) as {error?:string};
      if(!response.ok) throw new Error(payload.error ?? `Login gagal (${response.status})`);
      onLoggedIn();
    } catch(error) {
      toast.error(error instanceof Error?error.message:"Login gagal");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-950 text-white flex items-center justify-center px-4">
      <div className="w-full max-w-sm rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl">
        <h1 className="text-xl font-semibold">Fleet Intelligence</h1>
        <p className="mt-1 text-sm text-slate-400">Masuk dengan akun CST yang memiliki akses company.</p>
        <form className="mt-6 space-y-3" onSubmit={(e)=>{e.preventDefault(); void login("/api/auth/email-login",{email,password});}}>
          <input className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm" type="email" placeholder="Email" value={email} onChange={e=>setEmail(e.target.value)} required />
          <input className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm" type="password" placeholder="Password" value={password} onChange={e=>setPassword(e.target.value)} required />
          <button disabled={loading} className="w-full rounded-lg bg-indigo-600 px-3 py-2.5 text-sm font-medium disabled:opacity-50">{loading?"Memproses…":"Masuk"}</button>
        </form>
        {devLoginEnabled && (
          <button disabled={loading||!email} onClick={()=>void login("/api/auth/dev-login",{email})} className="mt-3 w-full rounded-lg border border-amber-600/60 px-3 py-2.5 text-sm text-amber-300 disabled:opacity-50">
            DEV Login dengan email
          </button>
        )}
      </div>
    </div>
  );
}

function AuthGate({ children }: { children: React.ReactNode }) {
  const [state,setState]=React.useState<"loading"|"authenticated"|"anonymous">("loading");
  const [user,setUser]=React.useState<SessionUser|null>(null);

  const check=React.useCallback(async()=>{
    setState("loading");
    try {
      const response=await fetch("/api/auth/user",{credentials:"include"});
      if(response.ok){
        const payload=await response.json() as {user?:SessionUser};
        setUser(payload.user ?? null);
        setState("authenticated");
        return;
      }
      setUser(null);
      setState("anonymous");
    } catch {
      setUser(null);
      setState("anonymous");
    }
  },[]);

  React.useEffect(()=>{void check();},[check]);

  if(state==="loading") return <Fallback />;
  if(state==="anonymous") return <LoginScreen onLoggedIn={()=>void check()} />;
  return <>{children}{user?.email?<div className="fixed bottom-2 right-3 z-50 rounded bg-slate-900/80 px-2 py-1 text-[10px] text-slate-500">{user.email}</div>:null}</>;
}

function Routes() {
  return (
    <Switch>
      <Route path="/"><Redirect to="/logistics/fleet-intelligence" /></Route>
      <Route path="/logistics"><Redirect to="/logistics/fleet-intelligence" /></Route>
      <Route path="/logistics/fleet-intelligence/upload" component={Upload} />
      <Route path="/logistics/fleet-intelligence/drivers/:extId/detail" component={DriverDetail} />
      <Route path="/logistics/fleet-intelligence/drivers" component={Drivers} />
      <Route path="/logistics/fleet-intelligence/vehicles" component={Vehicles} />
      <Route path="/logistics/fleet-intelligence/transactions" component={Transactions} />
      <Route path="/logistics/fleet-intelligence/macet" component={Macet} />
      <Route path="/logistics/fleet-intelligence/outstanding" component={Outstanding} />
      <Route path="/logistics/fleet-intelligence/analytics" component={Analytics} />
      <Route path="/logistics/fleet-intelligence/alerts" component={Alerts} />
      <Route path="/logistics/fleet-intelligence/accounting" component={Accounting} />
      <Route path="/logistics/fleet-intelligence/validation" component={Validation} />
      <Route path="/logistics/fleet-intelligence/expenses" component={Expenses} />
      <Route path="/logistics/fleet-intelligence/control-center" component={ControlCenter} />
      <Route path="/logistics/fleet-intelligence/dlq" component={DLQ} />
      <Route path="/logistics/fleet-intelligence/ledger-explorer" component={Ledger} />
      <Route path="/logistics/fleet-intelligence/reconciliation" component={Reconciliation} />
      <Route path="/logistics/fleet-intelligence/pipeline-monitor" component={Pipeline} />
      <Route path="/logistics/fleet-intelligence/driver-macet" component={DriverMacet} />
      <Route path="/logistics/fleet-intelligence/cash-payments" component={CashPayments} />
      <Route path="/logistics/fleet-intelligence" component={Dashboard} />
      <Route><div className="min-h-screen bg-slate-950 text-slate-300 flex items-center justify-center">Halaman Fleet tidak ditemukan.</div></Route>
    </Switch>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <React.Suspense fallback={<Fallback />}>
        <AuthGate><Routes /></AuthGate>
      </React.Suspense>
      <Toaster richColors theme="dark" />
    </QueryClientProvider>
  );
}
