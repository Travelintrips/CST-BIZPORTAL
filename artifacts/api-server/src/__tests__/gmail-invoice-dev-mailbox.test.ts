import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

const source = readFileSync(new URL("../routes/gmail-invoice-source.ts", import.meta.url), "utf8");

describe("Gmail DEV mailbox isolation", () => {
  it("does not fall back to PROD Gmail when DEV source email is absent", () => {
    expect(source).toContain('return isDevelopmentEnvironment() ? configured : configured || DEFAULT_SOURCE_EMAIL');
  });
  it("checks dedicated email on OAuth connect and Sync Now", () => {
    expect(source.match(/GMAIL_DEV_SOURCE_EMAIL_REQUIRED/g)).toHaveLength(2);
  });
});
