import { X509Certificate } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildPayrollDedicatedSslOptions, SUPABASE_ROOT_2021_CA_SHA256 } from "@workspace/db";

describe("Payroll PROD TLS certificate verified without disabling validation", () => {
  const base = "postgresql://bizportal_payroll_prod_login.nzdweipzckfszczzqtuw:test%40password@aws-1-ap-southeast-2.pooler.supabase.com:5432/postgres";

  it("loads pinned Supabase Root 2021 CA and checks pooler hostname", () => {
    const settings = buildPayrollDedicatedSslOptions(base + "?sslmode=require");
    const cert = new X509Certificate(settings.ssl.ca);
    expect(cert.fingerprint256.replaceAll(":", "").toLowerCase()).toBe(SUPABASE_ROOT_2021_CA_SHA256);
    expect(settings.ssl.rejectUnauthorized).toBe(true);
    expect(settings.ssl.servername).toBe("aws-1-ap-southeast-2.pooler.supabase.com");
    expect(settings.connectionString).not.toContain("sslmode");
    expect(new URL(settings.connectionString).password).toBe("test%40password");
    expect(new URL(settings.connectionString).username).toBe("bizportal_payroll_prod_login.nzdweipzckfszczzqtuw");
  });

  it("retains strict verification for explicit verify-full and direct PROD host", () => {
    const options=buildPayrollDedicatedSslOptions(
      "postgresql://bizportal_payroll_prod_login:test@db.nzdweipzckfszczzqtuw.supabase.co:5432/postgres?sslmode=verify-full"
    );
    expect(options.ssl.rejectUnauthorized).toBe(true);
    expect(options.ssl.servername).toBe("db.nzdweipzckfszczzqtuw.supabase.co");
  });

  it("never accepts insecure SSL modes or custom CA override query parameters", () => {
    for (const suffix of [
      "?sslmode=no-verify",
      "?sslmode=disable",
      "?sslmode=prefer",
      "?sslmode=verify-ca",
      "?sslrootcert=/tmp/attacker.crt",
      "?sslcert=/tmp/attacker.crt",
      "?sslkey=/tmp/attacker.key",
      "?ssl=0",
      "?uselibpqcompat=true",
    ]) {
      expect(() => buildPayrollDedicatedSslOptions(base + suffix)).toThrow();
    }
  });

  it("rejects arbitrary DNS targets even with trusted root", () => {
    expect(() => buildPayrollDedicatedSslOptions(
      "postgresql://user:pass@attacker.example.com:5432/postgres?sslmode=require"
    )).toThrow("PAYROLL_PROD_TLS_HOST_NOT_ALLOWED");
  });
});
