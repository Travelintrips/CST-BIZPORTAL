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

  it("requires a company scope guard in every Gmail source route", () => {
    const routes = Array.from(
      source.matchAll(/\brouter\.(get|post|put|patch|delete)\(\s*["']([^"']+)["']/g),
    );
    // Keep a baseline count so removing a route cannot silently weaken coverage.
    expect(routes.length).toBeGreaterThanOrEqual(9);

    const callbackPath = "/recon-classification/invoice-sources/gmail/callback";
    expect(routes.filter((match) => match[2] === callbackPath)).toHaveLength(1);

    for (let index = 0; index < routes.length; index += 1) {
      const route = routes[index]!;
      const nextRoute = routes[index + 1];
      const handler = source.slice(route.index!, nextRoute?.index ?? source.length);

      expect(handler).toContain("const actor = await requireFinanceAdmin(req)");
      if (route[2] === callbackPath) {
        // OAuth callback uses signed state and validates the actor's company
        // rather than accepting a client-provided company ID.
        expect(handler).toContain("parsedState = await parseState(");
        expect(handler).toContain("actor.companyId !== parsedState.companyId");
        expect(handler).toContain('reason: "company_scope_mismatch"');
      } else {
        expect(handler).toContain("const companyId = requireCompanyScope(");
        expect(handler).toContain("if (!companyId) return;");
      }
    }
  });

  it("revalidates the signed OAuth callback against the actor company", () => {
    expect(source).toContain("actor.companyId !== parsedState.companyId");
    expect(source).toContain('reason: "company_scope_mismatch"');
  });
});
