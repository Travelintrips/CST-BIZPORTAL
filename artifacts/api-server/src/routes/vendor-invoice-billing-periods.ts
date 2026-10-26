// Extract only explicitly recorded service/billing periods; invoiceDate is not a billing period.
export function vendorInvoiceBillingPeriods(filename: string | null, breakdown: unknown): string[] {
  const periods = new Set<string>();
  const monthIndex = (value: string): number | null => {
    const iso = /^(20\d{2})-(0?[1-9]|1[0-2])(?:-\d{1,2})?$/.exec(value);
    if (iso) return Number(iso[1]) * 12 + Number(iso[2]) - 1;
    const slash = /^(20\d{2})\/(0?[1-9]|1[0-2])(?:\/\d{1,2})?$/.exec(value);
    if (slash) return Number(slash[1]) * 12 + Number(slash[2]) - 1;
    const dotted = /^\d{1,2}\.(0?[1-9]|1[0-2])\.(20\d{2})$/.exec(value);
    if (dotted) return Number(dotted[2]) * 12 + Number(dotted[1]) - 1;
    return null;
  };
  const addMonth = (index: number) => {
    if (!Number.isInteger(index)) return;
    const year = Math.floor(index / 12);
    if (year < 2000 || year > 2099) return;
    periods.add(`${year}-${String(index % 12 + 1).padStart(2, "0")}`);
  };
  const add = (value: unknown) => {
    if (Array.isArray(value)) { value.forEach(add); return; }
    if (typeof value !== "string") return;
    const raw = value.trim();
    const direct = monthIndex(raw);
    if (direct !== null) { addMonth(direct); return; }
    // Range examples: 01.05.2026 - 31.05.2026, 2026-07-01 to 2026-07-31.
    const dates = raw.match(/(?:20\d{2}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}\.\d{1,2}\.20\d{2})/g);
    if (!dates || dates.length !== 2) return;
    const first = monthIndex(dates[0]);
    const last = monthIndex(dates[1]);
    if (first === null || last === null || first > last || last - first > 35) return;
    for (let month = first; month <= last; month++) addMonth(month);
  };
  if (breakdown && typeof breakdown === "object" && !Array.isArray(breakdown)) {
    const data = breakdown as Record<string, unknown>;
    const keys = ["billing_periods", "billingPeriods", "service_periods", "servicePeriods",
      "billing_period", "billingPeriod", "service_period", "servicePeriod", "period_start", "periodStart"];
    for (const key of keys) add(data[key]);
    for (const component of Array.isArray(data.components) ? data.components : []) {
      if (!component || typeof component !== "object") continue;
      const item = component as Record<string, unknown>;
      for (const key of keys) add(item[key]);
      const details = item.details;
      if (details && typeof details === "object" && !Array.isArray(details)) {
        const nested = details as Record<string, unknown>;
        for (const key of keys) add(nested[key]);
      }
    }
  }
  const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  for (const match of (filename ?? "").matchAll(/Per[. _-]*Posting[. _-]*(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)([0-9]{2})/gi)) {
    periods.add(`20${match[2]}-${String(months.indexOf(match[1].toUpperCase()) + 1).padStart(2, "0")}`);
  }
  return [...periods].sort();
}
