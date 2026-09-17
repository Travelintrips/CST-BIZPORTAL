import { describe, expect, it } from "vitest";
import { canAccessTenantDashboard } from "@/lib/tenantAccess";

describe("tenant dashboard access guard", () => {
  it("allows tenant roles only for tenant companies", () => {
    expect(canAccessTenantDashboard("admin", 1)).toBe(true);
    expect(canAccessTenantDashboard("owner", 4)).toBe(true);
    expect(canAccessTenantDashboard("manager", 1)).toBe(true);
    expect(canAccessTenantDashboard("super_admin", 4)).toBe(true);
  });

  it("denies unsupported roles and companies", () => {
    expect(canAccessTenantDashboard("finance", 1)).toBe(false);
    expect(canAccessTenantDashboard("admin", 2)).toBe(false);
    expect(canAccessTenantDashboard("admin", null)).toBe(false);
    expect(canAccessTenantDashboard(undefined, 1)).toBe(false);
  });

  it("denies consolidated scope because the endpoint requires one tenant company", () => {
    expect(canAccessTenantDashboard("admin", 1, true)).toBe(false);
  });
});