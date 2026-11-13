/**
 * Classify a failed, already-authorized, READ-ONLY Payroll PROD connection check.
 * This function must never return or log the raw database error or connection URL.
 */
export function payrollReadinessSafeReason(error: unknown): string {
  const record = typeof error === "object" && error !== null
    ? error as Record<string, unknown> : {};
  const code = typeof record.code === "string" ? record.code.toUpperCase() : "";
  const message = error instanceof Error ? error.message.slice(0, 2048).toLowerCase() : "";

  if (message.includes("payroll_database_changed_restart_required"))
    return "PAYROLL_PROD_RESTART_REQUIRED";
  if (message.includes("circuit breaker"))
    return "PAYROLL_PROD_POOLER_CIRCUIT_BREAKER";
  if (message.includes("tenant or user") || message.includes("worker_not_found") ||
      message.includes("(enotfound)") || message.includes("tenant/user"))
    return "PAYROLL_PROD_POOLER_ROUTING_FAILED";
  if (message.includes("eauthquery") || message.includes("invalid secret format"))
    return "PAYROLL_PROD_POOLER_AUTH_QUERY_FAILED";
  if (code === "28P01" || message.includes("password authentication failed"))
    return "PAYROLL_PROD_DATABASE_PASSWORD_REJECTED";
  if (code === "28000" || message.includes("authentication rejected"))
    return "PAYROLL_PROD_DATABASE_AUTH_REJECTED";
  if (code === "42501" || message.includes("permission denied") ||
      message.includes("must be member of role"))
    return "PAYROLL_PROD_DATABASE_PERMISSION_DENIED";
  if (code === "3D000" || message.includes("database does not exist"))
    return "PAYROLL_PROD_DATABASE_NAME_NOT_FOUND";
  if (["SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
       "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT",
       "ERR_TLS_CERT_ALTNAME_INVALID"].includes(code) ||
      message.includes("certificate verify failed"))
    return "PAYROLL_PROD_DATABASE_TLS_FAILED";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN")
    return "PAYROLL_PROD_DATABASE_DNS_FAILED";
  if (["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH",
       "ENETUNREACH"].includes(code) ||
      message.includes("connection timeout") || message.includes("timeout expired") ||
      message.includes("connection terminated"))
    return "PAYROLL_PROD_DATABASE_NETWORK_OR_TIMEOUT";
  // Unknown failures must not expose the upstream error, credentials or SQL.
  return "PAYROLL_PROD_DATABASE_OPERATION_FAILED";
}
