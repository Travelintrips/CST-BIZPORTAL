import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * HRD temporary access policy must not silently broaden admin/owner account
 * management when enabling verified Super Admin login for HRD.
 */
const auth = readFileSync(resolve(process.cwd(),"src/routes/dev-auth.ts"),"utf8");
const local = readFileSync(resolve(process.cwd(),"src/routes/local-production-auth.ts"),"utf8");
const hrd = readFileSync(resolve(process.cwd(),"src/routes/hrd-access.ts"),"utf8");

describe("Super Admin HRD authentication contract",()=>{
  it("preserves regular admin login and allows only active Super Admin in Supabase exchange",()=>{
    const start=auth.indexOf('router.post("/auth/supabase-exchange"');
    const end=auth.indexOf('router.get("/auth/dev-users"',start);
    const exchange=auth.slice(start,end);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(exchange).toContain("verifySupabaseAccessToken(accessToken)");
    expect(exchange).toContain('user.role === "super_admin"');
    expect(exchange).toContain("u.is_active IS TRUE");
    expect(exchange).toContain("lower(btrim(u.status))='active'");
    expect(exchange).toContain('user.role !== "admin" && !activeSuperAdmin');
    expect(exchange).toContain("setProductionSessionCookie(response, productionSession)");
  });
  it("allows active Super Admin OTP without broadening account management",()=>{
    const helper=local.slice(
      local.indexOf("function isActiveOtpLoginUser"),
      local.indexOf("async function getPrivilegedProductionUserFromRequest"),
    );
    expect(helper).toContain("isActivePrivilegedUser(user)");
    expect(helper).toContain('user?.role.trim().toLowerCase() === "super_admin"');
    expect(helper).toContain("user.isActive");
    expect(helper).toContain('user.status.trim().toLowerCase() === "active"');
    const send=local.slice(local.indexOf('router.post("/auth/email-otp/send"'),local.indexOf('router.post("/auth/email-otp/verify"'));
    const verify=local.slice(local.indexOf('router.post("/auth/email-otp/verify"'));
    expect(send).toContain("if (!isActiveOtpLoginUser(user))");
    expect(verify).toContain("if (!isActiveOtpLoginUser(user))");
    const existingManagementGate=local.slice(local.indexOf("function isActivePrivilegedUser"),local.indexOf("function isActiveOtpLoginUser"));
    expect(existingManagementGate).toContain('role === "admin" || role === "owner"');
    expect(existingManagementGate).not.toContain('"super_admin"');
    expect(local).toContain("return isActivePrivilegedUser(user) ? user : null");
  });
  it("keeps the final sensitive HRD authorization Super Admin only",()=>{
    expect(hrd).toContain('actor.role.trim().toLowerCase() !== "super_admin"');
    expect(hrd).not.toContain('"owner", "hrd"');
  });
});
