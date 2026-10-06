import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const hub = readFileSync(resolve(root, "src/pages/logistics/hub.tsx"), "utf8");
const workspace = readFileSync(resolve(root, "src/pages/logistics/workspace.tsx"), "utf8");
const executive = readFileSync(resolve(root, "src/pages/executive/workspace.tsx"), "utf8");

const fleetUrl = "https://fleet.cstlogistic.co.id/logistics/fleet-intelligence";

describe("Fleet standalone launcher", () => {
  it("launches standalone Fleet from Logistics Hub", () => {
    expect(hub).toContain(fleetUrl);
    expect(hub).toContain('href.startsWith("http")');
  });

  it("points Fleet workspace shortcuts to standalone routes", () => {
    expect(workspace).toContain(fleetUrl);
    expect(workspace).toContain(`${fleetUrl}/drivers`);
    expect(workspace).toContain(`${fleetUrl}/vehicles`);
    expect(workspace).toContain(`${fleetUrl}/transactions`);
    expect(workspace).toContain(`${fleetUrl}/outstanding`);
    expect(workspace).toContain('item.href.startsWith("http")');
  });

  it("launches standalone Fleet from Executive workspace", () => {
    expect(executive).toContain(fleetUrl);
    expect(executive).toContain('item.href.startsWith("http")');
  });
});
