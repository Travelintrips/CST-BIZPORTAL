import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const smtpSource = readFileSync(resolve(process.cwd(), "src/lib/smtp.ts"), "utf8");
const authSource = readFileSync(resolve(process.cwd(), "src/routes/local-production-auth.ts"), "utf8");

describe("admin email OTP SMTP contract", () => {
  it("keeps standalone Hostinger SMTP defaults when host/user are not explicitly set", () => {
    expect(smtpSource).toContain('configuredHost || "smtp.hostinger.com"');
    expect(smtpSource).toContain('configuredPort || (configuredHost ? "587" : "465")');
    expect(smtpSource).toContain("configuredUser || fallbackAddress");
  });

  it("logs delivery failures before invalidating the OTP record", () => {
    expect(authSource).toContain('request.log.error({ error, email }, "Admin email OTP delivery failed")');
    expect(authSource).toContain("delete from public.bizportal_email_otp_codes");
  });
});
