import React from "react";
import { Redirect, Route, Switch } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";

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
        <Routes />
      </React.Suspense>
      <Toaster richColors theme="dark" />
    </QueryClientProvider>
  );
}
