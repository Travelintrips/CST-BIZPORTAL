import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const healthSource = readFileSync(
  resolve(process.cwd(), "src/routes/health.ts"),
  "utf8",
);

describe("runtime health startup mode", () => {
  it("exposes the nonblocking startup contract on live and ready probes", () => {
    expect(healthSource).toContain('STARTUP_MODE = "nonblocking-session-init-v2"');
    expect(healthSource).toContain('res.json({ status: "ok", startupMode: STARTUP_MODE })');
    expect(healthSource).toContain("startupMode: STARTUP_MODE");
  });
});
