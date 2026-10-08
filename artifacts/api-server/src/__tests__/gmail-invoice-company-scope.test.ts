import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("../routes/gmail-invoice-source.ts", import.meta.url),
  "utf8",
);

describe("Gmail invoice source company isolation", () => {
  it("fails closed when an authenticated company user requests another company", () => {
    expect(source).toContain("function requireCompanyScope(");
    expect(source).toContain("actor.companyId != null && actor.companyId !== companyId");
    expect(source).toContain('"COMPANY_SCOPE_FORBIDDEN"');
  });

  it("uses the company scope guard on every Gmail source operation", () => {
    const matches = source.match(/requireCompanyScope\(/g) ?? [];
    expect(matches.length).toBe(7);
  });

  it("revalidates the signed OAuth callback against the actor company", () => {
    expect(source).toContain("actor.companyId !== parsedState.companyId");
    expect(source).toContain('reason: "company_scope_mismatch"');
  });
});
