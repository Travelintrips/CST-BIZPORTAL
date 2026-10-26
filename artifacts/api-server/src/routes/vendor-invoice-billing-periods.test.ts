import { describe, expect, it } from "vitest";
import { vendorInvoiceBillingPeriods } from "./vendor-invoice-billing-periods";

describe("vendorInvoiceBillingPeriods", () => {
  it("reads nested Indonesian date ranges in posted invoice components", () => {
    const breakdown = { components: [
      { details: { service_period: "01.05.2026 - 31.05.2026" } },
      { details: { service_period: "01.05.2026 - 31.05.2026" } },
    ] };
    expect(vendorInvoiceBillingPeriods(null, breakdown)).toEqual(["2026-05"]);
  });

  it("reads ISO ranges and deduplicates periods", () => {
    expect(vendorInvoiceBillingPeriods(null, { components: [
      { details: { service_period: "2026-07-01 to 2026-07-31" } },
      { details: { service_period: "2026-07-01 to 2026-07-31" } },
    ] })).toEqual(["2026-07"]);
  });

  it("lists every covered month for cross-month service", () => {
    expect(vendorInvoiceBillingPeriods(null, { components: [
      { details: { service_period: "2026-06-25 - 2026-08-05" } },
    ] })).toEqual(["2026-06", "2026-07", "2026-08"]);
  });

  it("keeps Gmail PerPosting month separate from invoice date", () => {
    expect(vendorInvoiceBillingPeriods("FK_PerPostingAUG26.pdf", { source: "gmail_invoice_source" })).toEqual(["2026-08"]);
  });

  it("does not guess billing periods from missing metadata", () => {
    expect(vendorInvoiceBillingPeriods(null, { extraction: { invoice_date: "2026-08-05" } })).toEqual([]);
  });
});
