import { describe, expect, it } from "vitest";
import { legacyRepairComponents, repairReason } from "./purchase-workflow";

describe("legacy withholding repair classification", () => {
  it("keeps wrong-line rows in the repair queue", () => {
    const reason = repairReason(
      [{
        invoiceLineId: 10,
        taxType: "PPh 23",
        taxObject: "Jasa",
        baseAmount: 1_000_000,
        taxAmount: 20_000,
        liabilityAccountId: null,
      }],
      [{
        id: 1,
        invoice_line_id: 11,
        tax_type: "PPh 23",
        tax_object: "Jasa",
        base_amount: "1000000",
        tax_amount: "20000",
        liability_account_id: 99,
        resolution_status: "confirmed",
      }],
    );

    expect(reason?.code).toBe("INCONSISTENT_VENDOR_WITHHOLDING_ROWS");
  });

  it("flags a combined legacy header for operator splitting", () => {
    const components = legacyRepairComponents({
      id: 7,
      invoice_number: "VI-7",
      supplier_name: "Vendor",
      status: "posted",
      grand_total: "1020000",
      total_amount: "1000000",
      withholding_tax_amount: "30000",
      withholding_tax_type: "PPh 23 + PPh 4(2)",
      tax_object: "legacy_invoice_header",
      invoice_breakdown: null,
      created_at: new Date(),
    });
    const reason = repairReason(
      components.map((component) => ({ ...component, invoiceLineId: 10 })),
      [],
    );

    expect(reason?.code).toBe("COMBINED_VENDOR_WITHHOLDING_ROW");
    expect(components).toHaveLength(1);
    expect(components[0]?.taxAmount).toBe(30_000);
  });

  it("does not queue an exact confirmed company-reviewed row", () => {
    const plans = [{
      invoiceLineId: 10,
      taxType: "PPh 23",
      taxObject: "Jasa",
      baseAmount: 1_000_000,
      taxAmount: 20_000,
      liabilityAccountId: 99,
    }];
    expect(repairReason(plans, [{
      id: 1,
      invoice_line_id: 10,
      tax_type: "PPh 23",
      tax_object: "Jasa",
      base_amount: "1000000",
      tax_amount: "20000",
      liability_account_id: 99,
      resolution_status: "confirmed",
    }])).toBeNull();
  });

  it("uses the persisted split as canonical after a combined header repair", () => {
    const components = legacyRepairComponents({
      id: 7,
      invoice_number: "VI-7",
      supplier_name: "Vendor",
      status: "posted",
      grand_total: "1020000",
      total_amount: "1000000",
      withholding_tax_amount: "30000",
      withholding_tax_type: "PPh 23 + PPh 4(2)",
      tax_object: "legacy_invoice_header",
      invoice_breakdown: {
        totals: { gross: 1_020_000 },
        withholding_repair_components: [
          {
            invoice_line_id: 10,
            tax_type: "PPh 23",
            tax_object: "Jasa",
            base_amount: 500_000,
            tax_amount: 10_000,
            liability_account_id: 91,
          },
          {
            invoice_line_id: 10,
            tax_type: "PPh 4(2)",
            tax_object: "Sewa",
            base_amount: 500_000,
            tax_amount: 20_000,
            liability_account_id: 92,
          },
        ],
      },
      created_at: new Date(),
    });
    const plans = components.map((component) => ({ ...component, invoiceLineId: component.invoiceLineId ?? 10 }));
    const taxes = plans.map((plan, index) => ({
      id: index + 1,
      invoice_line_id: plan.invoiceLineId,
      tax_type: plan.taxType,
      tax_object: plan.taxObject,
      base_amount: String(plan.baseAmount),
      tax_amount: String(plan.taxAmount),
      liability_account_id: plan.liabilityAccountId,
      resolution_status: "confirmed",
    }));

    expect(components.map((component) => component.taxType)).toEqual(["PPh 23", "PPh 4(2)"]);
    expect(components.reduce((sum, component) => sum + component.taxAmount, 0)).toBe(30_000);
    expect(repairReason(plans, taxes)).toBeNull();
  });
});