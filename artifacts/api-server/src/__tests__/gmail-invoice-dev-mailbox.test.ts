import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

const source = readFileSync(new URL("../routes/gmail-invoice-source.ts", import.meta.url), "utf8");

describe("Gmail DEV mailbox isolation", () => {
  it("does not fall back to PROD Gmail when DEV source email is absent", () => {
    expect(source).toContain('return isDevelopmentEnvironment() ? configured : configured || DEFAULT_SOURCE_EMAIL');
  });
  it("checks dedicated email on OAuth connect, manual verify, and Sync Now", () => {
    for (const action of ["connect", "verify-connection", "sync"]) {
      const route = `"/recon-classification/invoice-sources/gmail/${action}"`;
      const start = source.indexOf(route);
      expect(start).toBeGreaterThan(-1);
      const nextRoute = source.indexOf("\\nrouter.", start);
      const handler = source.slice(start, nextRoute < 0 ? undefined : nextRoute);
      expect(handler).toContain('"GMAIL_DEV_SOURCE_EMAIL_REQUIRED"');
    }
  });
});
