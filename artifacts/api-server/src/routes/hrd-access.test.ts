import { describe, expect, it } from "vitest";
import { authorizeHrdCompany, validateHrdEmployeeScope } from "./hrd-access";

describe("HRD private document company boundary", () => {
  const cst = { role: "hrd", companyId: 1 };
  it("allows HRD only in its session company", () => {
    expect(authorizeHrdCompany(cst, "1")).toBe(1);
    expect(authorizeHrdCompany(cst, "3")).toBeNull();
  });
  it("rejects unauthorized and unscoped actors", () => {
    expect(authorizeHrdCompany(null, "1")).toBeNull();
    expect(authorizeHrdCompany({ role: "viewer", companyId: 1 }, "1")).toBeNull();
    expect(authorizeHrdCompany({ role: "owner", companyId: null }, "1")).toBeNull();
    expect(authorizeHrdCompany({ role: "admin", companyId: null }, "3")).toBeNull();
  });
  it("requires an explicit valid company; rejects consolidated access", () => {
    for (const id of ["", "all", "0", "-1", "01", "1 OR 1=1", "99999999999999999999999"]) {
      expect(authorizeHrdCompany({ role: "super_admin", companyId: null }, id)).toBeNull();
    }
  });
  it("allows explicitly scoped super admin, not implicit all companies", () => {
    expect(authorizeHrdCompany({ role: "super_admin", companyId: null }, "1")).toBe(1);
    expect(authorizeHrdCompany({ role: "super_admin", companyId: null }, "3")).toBe(3);
    expect(authorizeHrdCompany({ role: "super_admin", companyId: null }, undefined)).toBeNull();
  });
  it("requires matched employee tenant before any document access", () => {
    expect(validateHrdEmployeeScope(1, 1)).toBe(true);
    expect(validateHrdEmployeeScope(1, 3)).toBe(false);
    expect(validateHrdEmployeeScope(null, 1)).toBe(false);
  });
});
