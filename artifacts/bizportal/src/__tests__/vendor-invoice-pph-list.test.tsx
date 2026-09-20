import React from "react";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("wouter", () => ({
  Link: ({ children, ...props }: any) => React.createElement("a", props, children),
  useLocation: () => ["/purchase/vendor-invoices", vi.fn()],
  useParams: () => ({}),
  useSearch: () => "",
}));

vi.mock("@/contexts/CompanyContext", () => ({
  useCompany: () => ({
    companies: [{ id: 1, companyName: "PT Cahaya Sejati Teknologi", companyCode: "CST" }],
    activeCompany: { id: 1, companyName: "PT Cahaya Sejati Teknologi", companyCode: "CST" },
    activeCompanyId: 1,
    isConsolidated: false,
    isLoading: false,
    refetch: vi.fn(),
  }),
}));

vi.mock("@/components/layout/AppShell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

import { VendorInvoicesListPage } from "@/pages/purchase/vendor-invoices";

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe("Vendor Invoice AP PPh list presentation", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.includes("/vendor-invoices/legacy-withholding-repairs")) {
        return response({ data: [], total: 0 });
      }
      if (path.includes("/vendor-invoices?company=1&page=1&pageSize=50")) {
        return response({
          data: [{
            id: 12,
            invoiceNumber: "VI/2026/00004",
            supplierName: "PT. ANGKASA PURA INDONESIA",
            status: "posted",
            grandTotal: 26852296,
            reconciledAmountPaid: 0,
            amountPaid: 0,
            threeWayMatchStatus: "unmatched",
            companyId: 1,
            invoiceDate: "2026-09-17T00:00:00.000Z",
            journalStatus: "posted",
            withholdingTaxAmount: 537045.92,
            withholdingTaxType: "PPh 23",
            invoiceBreakdown: {
              totals: {
                withholding_tax_amount: 537045.92,
                payable_amount: 26315250.08,
              },
              components: [{
                withholding_tax_type: "PPh 23",
                withholding_tax_amount: 537045.92,
              }],
            },
          }],
          page: 1,
          pageSize: 50,
          total: 1,
          hasMore: false,
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows PPh amount/type and calculates outstanding from net payable", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <VendorInvoicesListPage />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("PPh 23")).toBeTruthy();
    expect(screen.getByText((value) => value.includes("537.046"))).toBeTruthy();
    expect(screen.getByText((value) => value.includes("26.315.250"))).toBeTruthy();
  });
});
