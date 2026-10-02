import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getDatabaseSecretName: vi.fn(),
  readSecret: vi.fn(),
}));

vi.mock("@workspace/db", () => ({
  getDatabaseSecretName: dbMocks.getDatabaseSecretName,
  readSecret: dbMocks.readSecret,
}));

import { resolveSmtpConfig } from "./smtp";

const SMTP_ENV_KEYS = [
  "APP_ENV",
  "NODE_ENV",
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USER",
  "SMTP_PASS",
  "SMTP_PASSWORD",
  "SMTP_FROM",
  "SMTP_SECURE",
] as const;

const originalEnvironment = new Map(
  SMTP_ENV_KEYS.map((key) => [key, process.env[key]]),
);

describe("resolveSmtpConfig", () => {
  beforeEach(() => {
    for (const key of SMTP_ENV_KEYS) delete process.env[key];
    process.env.APP_ENV = "production";
    dbMocks.getDatabaseSecretName.mockReset();
    dbMocks.readSecret.mockReset();
    dbMocks.getDatabaseSecretName.mockReturnValue("cst-super-app-production");
  });

  afterEach(() => {
    for (const key of SMTP_ENV_KEYS) {
      const value = originalEnvironment.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("falls back to the managed production bundle when Hostinger did not inject SMTP variables", async () => {
    dbMocks.readSecret.mockResolvedValue(JSON.stringify({
      APP_ENV: "production",
      SMTP_FROM: "BizPortal <noreply@cstlogistic.co.id>",
      SMTP_USER: "noreply@cstlogistic.co.id",
      SMTP_PASS: "test-only-password",
    }));

    const config = await resolveSmtpConfig();

    expect(dbMocks.getDatabaseSecretName).toHaveBeenCalledWith(true);
    expect(dbMocks.readSecret).toHaveBeenCalledWith("cst-super-app-production");
    expect(config.host).toBe("smtp.hostinger.com");
    expect(config.port).toBe(465);
    expect(config.secure).toBe(true);
    expect(config.user).toBe("noreply@cstlogistic.co.id");
    expect(config.envelopeFrom).toBe("noreply@cstlogistic.co.id");
  });
});
