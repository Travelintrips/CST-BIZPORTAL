import { describe, expect, it } from "vitest";
import {
  deriveVendorInvoicePaymentStatus,
  ensureVendorWithholdingRecords,
  hasCombinedVendorWithholdingRow,
  inferVendorInvoiceGrossSettlement,
  resolveVendorInvoiceNetSettlement,
  vendorWithholdingTaxPlans,
} from "../lib/vendorInvoicePaymentStatus.js";

describe("vendor invoice payment status", () => {
  it("recognizes a net bank transfer as gross settlement when persisted PPh closes the balance", () => {
    expect(inferVendorInvoiceGrossSettlement({
      paymentAmount: 9_000,
      outstanding: 10_000,
      withholdingAmount: 1_000,
    })).toEqual({
      grossAmount: 10_000,
      withholdingAmount: 1_000,
    });
  });

  it("uses the gross balance as the comparison baseline for a persisted net payment", () => {
    const netPaid = 23_783_170;
    const grossTotal = 26_852_296;
    const withholding = 3_069_126;

    expect(inferVendorInvoiceGrossSettlement({
      paymentAmount: netPaid,
      outstanding: grossTotal,
      withholdingAmount: withholding,
    })).toEqual({
      grossAmount: grossTotal,
      withholdingAmount: withholding,
    });
  });

  it("does not credit the full PPh amount on a genuinely partial payment", () => {
    expect(inferVendorInvoiceGrossSettlement({
      paymentAmount: 4_000,
      outstanding: 10_000,
      withholdingAmount: 1_000,
    })).toEqual({
      grossAmount: 4_000,
      withholdingAmount: 0,
    });
  });

  it("keeps an invoice posted until withholding proof is complete", () => {
    expect(deriveVendorInvoicePaymentStatus({
      amountPaid: 10_000,
      grandTotal: 10_000,
      currentStatus: "posted",
      hasWithholding: true,
      withholdingComplete: false,
    })).toBe("posted");
  });

  it("marks the invoice paid after gross settlement and confirmed withholding proof", () => {
    expect(deriveVendorInvoicePaymentStatus({
      amountPaid: 10_000,
      grandTotal: 10_000,
      currentStatus: "posted",
      hasWithholding: true,
      withholdingComplete: true,
    })).toBe("paid");
  });

  it("does not use three-way match state to decide payment status", () => {
    const paymentStatus = deriveVendorInvoicePaymentStatus({
      amountPaid: 10_000,
      grandTotal: 10_000,
      currentStatus: "posted",
      hasWithholding: false,
      withholdingComplete: false,
    });
    expect(paymentStatus).toBe("paid");
    expect({ threeWayMatchStatus: "unmatched", paymentStatus }).toEqual({
      threeWayMatchStatus: "unmatched",
      paymentStatus: "paid",
    });
  });

  it("keeps PPh 23 and PPh 4(2) as separate payable tax rows", () => {
    const plans = vendorWithholdingTaxPlans({
      components: [
        {
          component: "concession",
          dpp: 13_000_000,
          withholding_tax_type: "PPh 23",
          withholding_tax_rate: 15,
          withholding_tax_amount: 1_950_000,
        },
        {
          component: "electricity",
          dpp: 10_566_250,
          withholding_tax_type: "PPh 4(2)",
          withholding_tax_rate: 10,
          withholding_tax_amount: 1_056_625,
        },
      ],
      totals: { gross: 26_852_296, withholding_tax_amount: 3_006_625 },
    });

    expect(plans).toEqual([
      {
        componentIndex: 0,
        type: "PPh 23",
        object: "concession",
        base: 13_000_000,
        amount: 1_950_000,
        liabilityAccountId: null,
      },
      {
        componentIndex: 1,
        type: "PPh 4(2)",
        object: "electricity",
        base: 10_566_250,
        amount: 1_056_625,
        liabilityAccountId: null,
      },
    ]);

    const withholding = plans.reduce((sum, plan) => sum + plan.amount, 0);
    expect(inferVendorInvoiceGrossSettlement({
      paymentAmount: 26_852_296 - withholding,
      outstanding: 26_852_296,
      withholdingAmount: withholding,
    })).toEqual({
      grossAmount: 26_852_296,
      withholdingAmount: withholding,
    });
  });

  it("surfaces an existing mixed PPh row for repair", () => {
    const plans = vendorWithholdingTaxPlans({
      components: [
        { component: "service", dpp: 1_000, withholding_tax_type: "PPh 23", withholding_tax_amount: 20 },
        { component: "rent", dpp: 2_000, withholding_tax_type: "PPh 4(2)", withholding_tax_amount: 200 },
      ],
    });

    expect(hasCombinedVendorWithholdingRow([
      { tax_type: "PPh 23 + PPh 4(2)", tax_object: "mixed", tax_amount: 220 },
    ], plans)).toBe(true);
    expect(hasCombinedVendorWithholdingRow([
      { tax_type: "PPh 23", tax_object: "service", tax_amount: 20 },
      { tax_type: "PPh 4(2)", tax_object: "rent", tax_amount: 200 },
    ], plans)).toBe(false);
  });

  it("materializes missing mixed PPh rows idempotently before net settlement", async () => {
    const taxRows: Array<Record<string, unknown>> = [];
    const records = new Map<number, { status: string; tax_amount: string }>();
    let taxInsertCount = 0;
    let recordInsertCount = 0;
    const queryText = (query: unknown): string => {
      const chunks = (query as { queryChunks?: unknown[] })?.queryChunks ?? [];
      return chunks.map((chunk) => {
        const value = (chunk as { value?: unknown })?.value;
        if (Array.isArray(value)) return value.join("");
        return typeof chunk === "string" ? chunk : "";
      }).join("");
    };
    const executor = {
      execute: async (query: unknown) => {
        const text = queryText(query);
        if (text.includes("FROM vendor_invoices")) {
          return {
            rows: [{
              id: 3,
              invoice_number: "VI/2026/00003",
              supplier_name: "PT Angkasa Pura Indonesia",
              total_amount: "23566250",
              withholding_tax_amount: "3006625",
              withholding_tax_type: "PPh 23 + PPh 4(2)",
              invoice_breakdown: {
                components: [
                  { component: "concession", dpp: 13_000_000 },
                  { component: "electricity", dpp: 10_566_250 },
                ],
              },
            }],
          };
        }
        if (text.includes("SELECT vit.id AS line_tax_id")) return { rows: taxRows };
        if (text.includes("SELECT id") && text.includes("FROM vendor_invoice_lines")) {
          return { rows: [{ id: 101 }, { id: 102 }] };
        }
        if (text.includes("INSERT INTO vendor_invoice_line_taxes")) {
          const plan = [
            { line_tax_id: 501, invoice_line_id: 101, tax_type: "PPh 23", tax_object: "concession", base_amount: "13000000", tax_amount: "1950000", liability_account_id: null },
            { line_tax_id: 502, invoice_line_id: 102, tax_type: "PPh 4(2)", tax_object: "electricity", base_amount: "10566250", tax_amount: "1056625", liability_account_id: null },
          ][taxInsertCount++];
          if (plan) taxRows.push(plan);
          return { rows: [] };
        }
        if (text.includes("INSERT INTO vendor_withholding_records")) {
          const tax = taxRows[recordInsertCount++ % taxRows.length]!;
          records.set(Number(tax.line_tax_id), {
            status: "proof_pending",
            tax_amount: String(tax.tax_amount),
          });
          return { rows: [] };
        }
        if (text.includes("FROM vendor_withholding_records")) {
          return { rows: [...records.values()] };
        }
        return { rows: [] };
      },
    };

    const first = await ensureVendorWithholdingRecords(executor, 1, 3);
    const second = await ensureVendorWithholdingRecords(executor, 1, 3);

    expect(taxRows.map((tax) => [tax.tax_type, tax.tax_object, tax.invoice_line_id])).toEqual([
      ["PPh 23", "concession", 101],
      ["PPh 4(2)", "electricity", 102],
    ]);
    expect(taxInsertCount).toBe(2);
    expect(first).toEqual({ withholdingAmount: 3_006_625, recordCount: 2 });
    expect(second).toEqual(first);
    taxRows[0]!.liability_account_id = 23101;
    taxRows[1]!.liability_account_id = 23102;
    expect(resolveVendorInvoiceNetSettlement({
      paymentAmount: 26_852_296 - first.withholdingAmount,
      outstanding: 26_852_296,
      taxes: taxRows.map((tax) => ({
        amount: Number(tax.tax_amount),
        liabilityAccountId: Number(tax.liability_account_id),
      })),
    })).toEqual({
      grossAmount: 26_852_296,
      withholdingAmount: 3_006_625,
      liabilityCredits: [
        { accountId: 23101, amount: 1_950_000 },
        { accountId: 23102, amount: 1_056_625 },
      ],
    });
  });

  it("rejects a header-only combined PPh import without creating a tax row", async () => {
    let taxInsertCount = 0;
    const queryText = (query: unknown): string => {
      const chunks = (query as { queryChunks?: unknown[] })?.queryChunks ?? [];
      return chunks.map((chunk) => {
        const value = (chunk as { value?: unknown })?.value;
        return Array.isArray(value) ? value.join("") : "";
      }).join("");
    };
    const executor = {
      execute: async (query: unknown) => {
        const text = queryText(query);
        if (text.includes("FROM vendor_invoices")) {
          return {
            rows: [{
              id: 3,
              invoice_number: "VI/2026/00003",
              supplier_name: "Legacy Vendor",
              total_amount: "10000",
              withholding_tax_amount: "1000",
              withholding_tax_type: "PPh 23 + PPh 4(2)",
              invoice_breakdown: null,
            }],
          };
        }
        if (text.includes("SELECT vit.id AS line_tax_id")) return { rows: [] };
        if (text.includes("FROM vendor_invoice_lines")) return { rows: [{ id: 101 }] };
        if (text.includes("INSERT INTO vendor_invoice_line_taxes")) taxInsertCount += 1;
        return { rows: [] };
      },
    };

    await expect(ensureVendorWithholdingRecords(executor, 1, 3))
      .rejects.toMatchObject({ code: "COMBINED_VENDOR_WITHHOLDING_ROW", httpStatus: 422 });
    await expect(ensureVendorWithholdingRecords(executor, 1, 3))
      .rejects.toMatchObject({ code: "COMBINED_VENDOR_WITHHOLDING_ROW", httpStatus: 422 });
    expect(taxInsertCount).toBe(0);
  });
});
