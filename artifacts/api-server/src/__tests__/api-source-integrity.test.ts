import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function source(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

const canonicalFiles = [
  { name: "routes/accounting.ts", text: source("../routes/accounting.ts") },
  { name: "lib/bank-sheet-sync.ts", text: source("../lib/bank-sheet-sync.ts") },
  { name: "lib/bank-sheet-sync.test.ts", text: source("../lib/bank-sheet-sync.test.ts") },
];

function occurrences(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length;
}

describe("canonical API source integrity", () => {
  it.each(canonicalFiles)("$name has no stale whole-file block-comment wrapper", ({ text }) => {
    expect(text).not.toMatch(/\/\*[\s\S]*export default router;\s*\*\/[\s\S]*export default router;/);
    expect(text).not.toMatch(/\/\*[\s\S]*import [\s\S]*\*\/[\s\S]*import /);
  });

  it("accounting router has one canonical router implementation", () => {
    const text = canonicalFiles[0].text;
    expect(occurrences(text, /const router: IRouter = Router\(\);/g)).toBe(1);
    expect(occurrences(text, /^export default router;\s*$/gm)).toBe(1);
  });

  it("bank sheet sync module has one top-level implementation", () => {
    const text = canonicalFiles[1].text;
    expect(occurrences(text, /^import crypto from "node:crypto";\s*$/gm)).toBe(1);
    expect(occurrences(text, /^export function parseAmount\(/gm)).toBe(1);
    expect(occurrences(text, /^export async function syncOneBankSheetConfig\(/gm)).toBe(1);
  });

  it("bank sheet sync test file has one test harness and no duplicate named cases", () => {
    const text = canonicalFiles[2].text;
    expect(occurrences(text, /^import \{ beforeEach, describe, expect, it, vi \} from "vitest";\s*$/gm)).toBe(1);
    expect(occurrences(text, /^import \{ parseAmount \} from "\.\/bank-sheet-sync";\s*$/gm)).toBe(1);

    const names = [...text.matchAll(/\bit\("([^"]+)"/g)].map((match) => match[1]);
    const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
    expect(duplicates, `duplicate test implementations in artifacts/api-server/src/lib/bank-sheet-sync.test.ts: ${[...new Set(duplicates)].join(", ")}`).toEqual([]);
  });
});
