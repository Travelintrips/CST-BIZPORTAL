import { describe, expect, it } from "vitest";
import { payrollReadinessSafeReason } from "./payroll-prod-readiness-error";

describe("Payroll PROD read-only connection error classifier", () => {
  const err = (code: string, message: string) => Object.assign(new Error(message), { code });
  const cases: Array<[unknown, string]> = [
    [err("28P01", 'password authentication failed for user "secret_login"'), "PAYROLL_PROD_DATABASE_PASSWORD_REJECTED"],
    [err("28000", "authorization rejected"), "PAYROLL_PROD_DATABASE_AUTH_REJECTED"],
    [err("42501", "permission denied on payroll table"), "PAYROLL_PROD_DATABASE_PERMISSION_DENIED"],
    [err("3D000", "database does not exist"), "PAYROLL_PROD_DATABASE_NAME_NOT_FOUND"],
    [err("ENOTFOUND", "getaddrinfo ENOTFOUND private.example"), "PAYROLL_PROD_DATABASE_DNS_FAILED"],
    [err("ETIMEDOUT", "connection timeout"), "PAYROLL_PROD_DATABASE_NETWORK_OR_TIMEOUT"],
    [err("CERT_HAS_EXPIRED", "certificate expired"), "PAYROLL_PROD_DATABASE_TLS_FAILED"],
    [err("XX000", "FATAL: (ENOTFOUND) tenant/user invalid"), "PAYROLL_PROD_POOLER_ROUTING_FAILED"],
    [err("XX000", "FATAL: (EAUTHQUERY) invalid secret format"), "PAYROLL_PROD_POOLER_AUTH_QUERY_FAILED"],
    [err("XX000", "Circuit breaker open"), "PAYROLL_PROD_POOLER_CIRCUIT_BREAKER"],
    [err("", "PAYROLL_DATABASE_CHANGED_RESTART_REQUIRED"), "PAYROLL_PROD_RESTART_REQUIRED"],
    [err("XX999", "postgresql://secret-user:secret-password@private-host:5432/postgres"), "PAYROLL_PROD_DATABASE_OPERATION_FAILED"],
    [{message:"malformed raw url",code:123}, "PAYROLL_PROD_DATABASE_OPERATION_FAILED"],
    [null, "PAYROLL_PROD_DATABASE_OPERATION_FAILED"],
  ];

  for (const [input, expected] of cases) {
    it("returns only fixed failure classification: " + expected, () => {
      const result=payrollReadinessSafeReason(input);
      expect(result).toBe(expected);
      expect(result).toMatch(/^PAYROLL_PROD_[A-Z_]+$/);
      expect(result).not.toContain("secret");
      expect(result).not.toContain("postgresql://");
      expect(result).not.toContain("private-host");
    });
  }
});
