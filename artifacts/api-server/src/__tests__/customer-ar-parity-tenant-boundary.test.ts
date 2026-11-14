import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const route = readFileSync(
  new URL("../routes/customer-ar-match-preview.ts", import.meta.url), "utf8",
);
const index = readFileSync(
  new URL("../routes/index.ts", import.meta.url), "utf8",
);

describe("canonical DEV Customer AR preview parity: no tenant leakage or writes", () => {
  it("mounts the existing read-only preview without changing Finance writers", () => {
    expect(index).toContain('import customerArMatchPreviewRouter from "./customer-ar-match-preview"');
    expect(index).toContain("router.use(customerArMatchPreviewRouter)");
    expect(route).toContain('router.get("/sales/customer-invoices/auto-match-preview"');
    expect(route).not.toMatch(/router\.(post|patch|put|delete)\(/);
    expect(route).toContain("autoApproveEnabled: false");
    expect(route).toContain("autoPostEnabled: false");
  });

  it("allows cross-company selection only for a verified global Super Admin", () => {
    expect(route).toContain('actor.role.trim().toLowerCase() === "super_admin"');
    expect(route).toContain("!globalSuperAdmin && actor.companyId !== companyId");
    expect(route).toContain("COMPANY_SCOPE_MISSING");
    expect(route).toContain("COMPANY_SCOPE_MISMATCH");
    expect(route).not.toContain('["super_admin", "owner"]');
  });

  it("requires scoped posted AR and unmatched incoming bank evidence", () => {
    expect(route).toContain("ledger.company_id = sd.company_id and ledger.invoice_id = sd.id");
    expect(route).toContain("entry.status::text = 'posted'");
    expect(route).toContain("where company_id = $1 and upper(direction) = 'IN'");
    expect(route).toContain("lower(status) = 'unmatched'");
    expect(route).toContain("buildCustomerArMatchPreview(invoices, mutations)");
  });
});
