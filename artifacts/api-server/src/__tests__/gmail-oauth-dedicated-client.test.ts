import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("../routes/gmail-invoice-source.ts", import.meta.url),
  "utf8",
);

describe("Gmail OAuth credential isolation", () => {
  it("prefers dedicated Gmail OAuth credentials before shared Google credentials", () => {
    expect(source).toContain('getRuntimeConfig("GMAIL_GOOGLE_CLIENT_ID")');
    expect(source).toContain('getRuntimeConfig("GMAIL_GOOGLE_CLIENT_SECRET")');
    expect(source).toContain('getRuntimeConfig("GOOGLE_CLIENT_ID")');
    expect(source).toContain('getRuntimeConfig("GOOGLE_CLIENT_SECRET")');
  });
});
