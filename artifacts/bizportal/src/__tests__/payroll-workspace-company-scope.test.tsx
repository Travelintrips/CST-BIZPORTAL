import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const companyState = vi.hoisted(() => ({ id: 11 as number | null, consolidated: false }));
vi.mock("@/contexts/CompanyContext", () => ({
  useCompany: () => ({
    activeCompanyId: companyState.id,
    activeCompany: companyState.id ? { companyName: `Perusahaan ${companyState.id}` } : null,
    isConsolidated: companyState.consolidated,
    isLoading: false,
  }),
}));
vi.mock("@/components/layout/AppShell", () => ({ AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
import PayrollWorkspace from "@/pages/hr/payroll";

const runs = {
  11: [{ id: 101, companyId: 11, month: 11, year: 2026, status: "draft" }, { id: 102, companyId: 11, month: 10, year: 2026, status: "approved" }],
  22: [{ id: 202, companyId: 22, month: 9, year: 2026, status: "paid" }],
};
const details: Record<number, object> = {
  101: { run: runs[11][0], items: [{ item: { id: 401, employeeId: 1, baseSalary: "5000000", allowance: "0", grossSalary: "5000000", kasbonDeduction: "0", netSalary: "5000000" }, employee: { firstName: "ALFA", lastName: "TEST" } }] },
  202: { run: runs[22][0], items: [{ item: { id: 402, employeeId: 2, baseSalary: "7000000", allowance: "0", grossSalary: "7000000", kasbonDeduction: "0", netSalary: "7000000" }, employee: { firstName: "BETA", lastName: "TEST" } }] },
};
const urls: string[] = [];
function successfulResponse(data: object) { return { ok: true, status: 200, json: async () => data } as Response; }

beforeEach(() => {
  companyState.id = 11;
  companyState.consolidated = false;
  urls.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    urls.push(String(url));
    const target = new URL(String(url), "http://localhost");
    const companyId = Number(target.searchParams.get("companyId"));
    if (target.pathname === "/api/payroll/capabilities") return successfulResponse({ companyId, canCreateDraft: false, canGenerate: false, canEditItems: false });
    if (target.pathname === "/api/payroll/runs") return successfulResponse({ runs: runs[companyId as 11 | 22] ?? [] });
    const match = target.pathname.match(/^\/api\/payroll\/runs\/(\d+)$/);
    if (match) return successfulResponse(details[Number(match[1])] ?? { run: null, items: [] });
    throw new Error(`Unexpected URL: ${url}`);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Payroll workspace company isolation and HRD filters", () => {
  it("filters status, period, and employee locally without activating financial writes", async () => {
    render(<PayrollWorkspace />);
    await screen.findByText("11/2026");
    expect(screen.getByText("10/2026")).toBeTruthy();
    expect(screen.getByText("Perusahaan 11")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Filter status payroll"), { target: { value: "approved" } });
    expect(screen.queryByText("11/2026")).toBeNull();
    expect(screen.getByText("10/2026")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Filter status payroll"), { target: { value: "all" } });
    fireEvent.change(screen.getByPlaceholderText("Contoh: 11/2026 atau #12"), { target: { value: "11/2026" } });
    expect(screen.queryByText("10/2026")).toBeNull();
    fireEvent.click(screen.getByText("11/2026").closest("button")!);
    await screen.findByText("ALFA TEST");
    fireEvent.change(screen.getByLabelText("Cari karyawan payroll"), { target: { value: "not found" } });
    expect(screen.getByText("Tidak ada karyawan sesuai pencarian.")).toBeTruthy();
    expect(screen.queryByText("ALFA TEST")).toBeNull();
    expect(urls.every((url) => url.includes("companyId=11"))).toBe(true);
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.every(([, options]) => !options || options.method === undefined)).toBe(true);
  });

  it("clears company A data and selections when switching to B and consolidated mode", async () => {
    const page = render(<PayrollWorkspace />);
    await screen.findByText("11/2026");
    fireEvent.click(screen.getByText("11/2026").closest("button")!);
    await screen.findByText("ALFA TEST");
    companyState.id = 22;
    page.rerender(<PayrollWorkspace />);
    await screen.findByText("09/2026");
    await waitFor(() => expect(screen.queryByText("ALFA TEST")).toBeNull());
    expect(screen.queryByText("11/2026")).toBeNull();
    expect(screen.getByText("Perusahaan 22")).toBeTruthy();
    fireEvent.click(screen.getByText("09/2026").closest("button")!);
    await screen.findByText("BETA TEST");
    companyState.id = null;
    companyState.consolidated = true;
    page.rerender(<PayrollWorkspace />);
    await waitFor(() => expect(screen.queryByText("BETA TEST")).toBeNull());
    expect(screen.queryByText("09/2026")).toBeNull();
    expect(screen.getByText(/Mode Konsolidasi tidak dapat/)).toBeTruthy();
    expect(urls.filter((url) => url.includes("companyId=all")).length).toBe(0);
    expect(urls.filter((url) => url.includes("companyId=22")).length).toBeGreaterThan(0);
  });

  it("ignores stale company A API responses arriving after company B is selected", async () => {
    let releaseA!: (response: Response) => void;
    const delayedA = new Promise<Response>((resolve) => { releaseA = resolve; });
    const regularFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const target = new URL(String(url), "http://localhost");
      if (target.searchParams.get("companyId") === "11" && target.pathname === "/api/payroll/runs") return delayedA;
      return regularFetch(url);
    }));
    const page = render(<PayrollWorkspace />);
    await waitFor(() => expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.some(([url]) => String(url).includes("companyId=11"))).toBe(true));
    companyState.id = 22;
    page.rerender(<PayrollWorkspace />);
    await screen.findByText("09/2026");
    releaseA(successfulResponse({ runs: runs[11] }));
    await waitFor(() => {
      expect(screen.queryByText("11/2026")).toBeNull();
      expect(screen.getByText("09/2026")).toBeTruthy();
      expect(screen.getByText("Perusahaan 22")).toBeTruthy();
    });
  });
  it("never displays a late company A payroll detail after switching to company B", async () => {
    let releaseDetailA!: (response: Response) => void;
    const delayedDetailA = new Promise<Response>((resolve) => { releaseDetailA = resolve; });
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const target = new URL(String(url), "http://localhost");
      if (target.pathname === "/api/payroll/runs/101" && target.searchParams.get("companyId") === "11") return delayedDetailA;
      return originalFetch(url);
    }));
    const page = render(<PayrollWorkspace />);
    await screen.findByText("11/2026");
    fireEvent.click(screen.getByText("11/2026").closest("button")!);
    await waitFor(() => expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.some(([url]) => String(url).includes("/runs/101?companyId=11"))).toBe(true));
    companyState.id = 22;
    page.rerender(<PayrollWorkspace />);
    await screen.findByText("09/2026");
    releaseDetailA(successfulResponse(details[101]));
    await waitFor(() => {
      expect(screen.queryByText("ALFA TEST")).toBeNull();
      expect(screen.queryByText("11/2026")).toBeNull();
      expect(screen.getByText("Perusahaan 22")).toBeTruthy();
    });
    fireEvent.click(screen.getByText("09/2026").closest("button")!);
    await screen.findByText("BETA TEST");
    expect(screen.queryByText("ALFA TEST")).toBeNull();
  });
});
