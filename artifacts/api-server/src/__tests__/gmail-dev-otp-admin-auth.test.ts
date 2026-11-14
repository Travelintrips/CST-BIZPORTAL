import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const route = readFileSync(new URL("../routes/gmail-invoice-source.ts", import.meta.url), "utf8");
const tab = readFileSync(new URL("../../../bizportal/src/pages/finance/recon-config/InvoiceSourcesTab.tsx", import.meta.url), "utf8");

describe("Gmail invoice OAuth with OTP-authenticated BizPortal DEV session", () => {
  it("accepts signed OTP sessions while retaining legacy DEV cookie support", () => {
    const getActor = route.slice(route.indexOf("async function getActor("), route.indexOf("async function requireFinanceAdmin("));
    expect(getActor).toContain("const legacyDevActor = getDevSession(request)");
    expect(getActor).toContain("if (legacyDevActor) return legacyDevActor");
    expect(getActor).toContain("const session = getProductionSession(request)");
    expect(getActor).toContain("if (!session) return null");
    expect(getActor).toContain("return getProductionUser(session)");
    expect(getActor).not.toContain("return getDevSession(request);");
  });

  it("continues to check Finance/Admin role and company scope", () => {
    expect(route).toContain('["admin", "owner", "super_admin"].includes(role)');
    expect(route).toContain("actor.companyId != null && actor.companyId !== companyId");
    expect(route).toContain('"COMPANY_SCOPE_FORBIDDEN"');
  });

  it("does not misreport missing Google OAuth while status is unavailable", () => {
    expect(tab).toContain("{status !== null && !status.oauthConfigured && (");
    expect(tab).not.toContain("{!status?.oauthConfigured && (");
  });
});
