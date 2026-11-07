import { describe, expect, it } from "vitest";
import { authorizePayrollCompany } from "./payroll-access";

describe("payroll cross-company isolation", () => {
  const admin = { role: "admin", companyId: 1 };
  const finance = { role: "finance", companyId: 1 };

  it("requires a signed-in payroll role and an explicit positive company", () => {
    expect(authorizePayrollCompany(null, "1")).toBeNull();
    expect(authorizePayrollCompany({ role: "driver", companyId: 1 }, "1")).toBeNull();
    for (const raw of [undefined, "", "all", "0", "-1", "1a", "1.2", "01", "9007199254740992"]) {
      expect(authorizePayrollCompany(admin, raw)).toBeNull();
    }
  });

  it("locks finance and accounting to their assigned company", () => {
    expect(authorizePayrollCompany(finance, "1")).toBe(1);
    expect(authorizePayrollCompany(finance, "2")).toBeNull();
    expect(authorizePayrollCompany({ role: "accounting", companyId: null }, "1")).toBeNull();
  });

  it("permits explicitly selected companies for privileged multi-company roles", () => {
    expect(authorizePayrollCompany(admin, "2")).toBeNull();
    expect(authorizePayrollCompany(admin, "1")).toBe(1);
    expect(authorizePayrollCompany({ role: "admin", companyId: null }, "3")).toBe(3);
    expect(authorizePayrollCompany({ role: "owner", companyId: 1 }, "3")).toBe(3);
    expect(authorizePayrollCompany({ role: "super_admin", companyId: null }, "4")).toBe(4);
  });
});
