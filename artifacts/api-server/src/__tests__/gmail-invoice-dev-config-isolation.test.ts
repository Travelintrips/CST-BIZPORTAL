import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { gmailConfigEnvironment } from "../lib/gmail-invoice-runtime";

const route = readFileSync(new URL("../routes/gmail-invoice-source.ts", import.meta.url), "utf8");
const runtime = readFileSync(new URL("../lib/gmail-invoice-runtime.ts", import.meta.url), "utf8");

describe("Gmail configuration isolation in DEV", () => {
  it("never resolves the production environment for DEV", () => {
    expect(gmailConfigEnvironment("development", "production")).toBe("development");
    expect(gmailConfigEnvironment(undefined, "test")).toBe("development");
    expect(gmailConfigEnvironment("production", "development")).toBe("production");
  });

  it("scopes app_config to the current environment", () => {
    expect(runtime).toContain("environment in ('all',$2)");
    expect(runtime).toContain("[key, gmailConfigEnvironment()]");
    expect(runtime).not.toContain("environment in ('all','production')");
  });

  it("requires dedicated Google OAuth credentials in DEV", () => {
    expect(route).toContain('if (isDevelopmentEnvironment()) return dedicated;');
    expect(route).toContain('getRuntimeConfig("GMAIL_GOOGLE_CLIENT_ID")');
    expect(route).toContain('getRuntimeConfig("GMAIL_GOOGLE_CLIENT_SECRET")');
  });

  it("tags saved source state correctly as development instead of production", () => {
    expect(route).toContain('isDevelopmentEnvironment() ? "development" : "production"');
    expect(route).toContain('values($1,$2,$3,$4,$6,now(),$5)');
    expect(route).toContain("environment=excluded.environment");
  });
});
