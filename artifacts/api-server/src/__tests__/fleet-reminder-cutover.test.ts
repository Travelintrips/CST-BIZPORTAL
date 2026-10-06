import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(process.cwd(), "src/index.ts"), "utf8");

describe("embedded Fleet reminder cutover", () => {
  it("defaults the embedded scheduler off", () => {
    expect(source).toContain('FLEET_EMBEDDED_REMINDER_ENABLED');
    expect(source).toContain('=== "true"');
    expect(source).toContain('standalone Fleet owns reminder scheduling');
  });

  it("retains an explicit rollback flag", () => {
    expect(source).toContain("embeddedFleetReminderEnabled");
    expect(source).toContain("if (fleetReminderTimer)");
  });
});
