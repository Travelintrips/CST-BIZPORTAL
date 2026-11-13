import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const readSource = (path: string) => readFileSync(resolve(process.cwd(), "src", path), "utf8");

describe("HRD sidebar uses existing routes and authorization", () => {
  const sidebar = readSource("components/layout/AppShell.tsx");
  const hub = readSource("pages/hr/index.tsx");
  const routes = readSource("routes.tsx");

  it("adds exactly one HRD top-level navigation item to the existing hub", () => {
    const items = sidebar.match(/titleKey:\s*"HRD"/g) ?? [];
    expect(items).toHaveLength(1);
    expect(sidebar).toMatch(/type:\s*"flat",\s*titleKey:\s*"HRD",\s*href:\s*"\/hr",\s*icon:\s*Users,/);
    expect(routes).toContain('<Route path="/hr" component={PR(HrHubPage)} />');
    expect(routes).toContain('<Route path="/hr/employees" component={PR(HrdEmployeeDirectoryPage)} />');
  });

  it("preserves the authenticated readiness check before offering private employee documents", () => {
    expect(hub).toContain('fetch(`/api/hrd/readiness?companyId=${companyId}`');
    expect(hub).toContain("body?.roleIsolated === true");
    expect(hub).toContain("canOpenPrivateHrd &&");
    expect(hub).toContain('href="/hr/employees"');
    // The generic navigation must go through /hr, not bypass private readiness.
    const hrdNav = sidebar.slice(sidebar.indexOf('titleKey: "HRD"'), sidebar.indexOf('titleKey: "HRD"') + 190);
    expect(hrdNav).toContain('href: "/hr"');
    expect(hrdNav).not.toContain('href: "/hr/employees"');
  });

  it("keeps the existing payroll navigation rather than rebuilding it", () => {
    expect(sidebar).toContain('titleKey: "Gaji Karyawan"');
    expect(sidebar).toContain('href: "/hr/payroll"');
  });
});
