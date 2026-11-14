import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const route = readFileSync(new URL("../routes/gmail-invoice-source.ts", import.meta.url), "utf8");
const tab = readFileSync(new URL("../../../bizportal/src/pages/finance/recon-config/InvoiceSourcesTab.tsx", import.meta.url), "utf8");
const start = route.indexOf('"/recon-classification/invoice-sources/gmail/verify-connection"');
const end = route.indexOf("// Provisional Match INV discovery", start);
const preflight = route.slice(start, end);

describe("DEV Gmail connection preflight is read-only and tenant scoped", () => {
  it("is a separate explicit action unavailable in production", () => {
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(preflight).toContain("!isDevelopmentEnvironment()");
    expect(preflight).toContain("res.status(404)");
    expect(tab).toContain("Verifikasi koneksi (tanpa impor)");
    expect(tab).toContain('"/api/recon-classification/invoice-sources/gmail/verify-connection"');
  });

  it("requires verified role and company scope before reading tokens", () => {
    expect(preflight).toContain("await requireFinanceAdmin(req)");
    expect(preflight).toContain("requireCompanyScope(");
    expect(preflight).toContain('getConfig(companyId, "REFRESH_TOKEN")');
    expect(preflight).toContain('getConfig(companyId, "EMAIL")');
    expect(preflight).toContain("storedEmail.trim().toLowerCase() !== expectedEmail");
    expect(preflight).toContain('"GMAIL_ACCOUNT_MISMATCH"');
  });

  it("only refreshes OAuth and reads Gmail profile, never imports or writes", () => {
    expect(preflight).toContain("await decryptRefreshToken(encryptedToken)");
    expect(preflight).toContain("await refreshAccessToken(");
    expect(preflight).toContain("await gmailProfile(accessToken)");
    expect(preflight).not.toMatch(/\b(setConfig|syncGmailInvoiceCandidates|importGmailInvoiceCandidate|reviewGmailInvoiceCandidate|provisionGmailOrganizationRules)\s*\(/);
    expect(preflight).toContain('verifiedScope: "gmail_profile_only"');
    expect(preflight).toContain("inboxScanned: false");
    expect(preflight).toContain("invoiceImported: false");
  });

  it("requires the UI to verify the returned company and show no-import scope", () => {
    expect(tab).toContain("verified.companyId !== companyId");
    expect(tab).toContain('verified.verifiedScope !== "gmail_profile_only"');
    expect(tab).toContain("verified.inboxScanned !== false");
    expect(tab).toContain("verified.invoiceImported !== false");
    expect(tab).toContain("Hanya profil Gmail diperiksa; inbox dan invoice belum diproses.");
  });

  it("ignores an old verification response after selecting a different company", () => {
    expect(tab).toContain("const verifyRequestSerial = useRef(0)");
    expect(tab).toContain("verifyRequestSerial.current += 1");
    expect(tab).toContain("const requestSerial = ++verifyRequestSerial.current");
    expect(tab).toContain("if (requestSerial !== verifyRequestSerial.current) return");
    expect(tab).toContain("if (requestSerial === verifyRequestSerial.current) setAction(null)");
  });
});
