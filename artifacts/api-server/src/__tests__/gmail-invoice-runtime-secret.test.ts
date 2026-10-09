import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("../lib/gmail-invoice-runtime.ts", import.meta.url),
  "utf8",
);

describe("Gmail invoice runtime secret source", () => {
  it("prefers the managed production bundle for OPENAI_API_KEY", () => {
    expect(source).toContain("readManagedProductionConfig");
    expect(source).toContain("getDatabaseSecretName(true)");
    expect(source).toContain('"OPENAI_API_KEY"');
    expect(source).toContain("readSecret");
  });

  it("keeps app_config as a fallback if managed secret access is unavailable", () => {
    expect(source).toContain("Fall through to app_config");
    expect(source).toContain("select value from public.app_config");
  });
});
