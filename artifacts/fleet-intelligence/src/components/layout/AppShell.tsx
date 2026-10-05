import type { ReactNode } from "react";
import { Link, useLocation } from "wouter";

const NAV = [
  ["Dashboard","/logistics/fleet-intelligence"],
  ["Drivers","/logistics/fleet-intelligence/drivers"],
  ["Vehicles","/logistics/fleet-intelligence/vehicles"],
  ["Transactions","/logistics/fleet-intelligence/transactions"],
  ["Outstanding","/logistics/fleet-intelligence/outstanding"],
  ["Analytics","/logistics/fleet-intelligence/analytics"],
  ["Alerts","/logistics/fleet-intelligence/alerts"],
  ["Accounting","/logistics/fleet-intelligence/accounting"],
  ["Control Center","/logistics/fleet-intelligence/control-center"],
];

export function AppShell({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="sticky top-0 z-40 border-b border-slate-800 bg-slate-900/80 px-5 py-3 backdrop-blur">
        <div className="flex items-center justify-between gap-4">
          <div><div className="font-semibold">Fleet Intelligence</div><div className="text-xs text-slate-400">CST standalone workspace</div></div>
          <nav className="hidden xl:flex flex-wrap justify-end gap-1">
            {NAV.map(([label,href]) => <Link key={href} href={href}><span className={`cursor-pointer rounded-md px-2.5 py-1.5 text-xs ${location===href?"bg-indigo-600 text-white":"text-slate-400 hover:bg-slate-800 hover:text-white"}`}>{label}</span></Link>)}
          </nav>
        </div>
      </header>
      <main className="p-4 md:p-6">{children}</main>
    </div>
  );
}
