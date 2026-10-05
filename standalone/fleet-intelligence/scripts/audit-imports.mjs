import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const pagesDir = resolve(root, "source/frontend/pages");
const files = (await readdir(pagesDir)).filter((name) => name.endsWith(".tsx")).sort();
const imports = new Map();

for (const file of files) {
  const text = await readFile(resolve(pagesDir, file), "utf8");
  const regex = /(?:from\s+|import\s*\()["']([^"']+)["']/g;
  for (const match of text.matchAll(regex)) {
    const spec = match[1];
    const list = imports.get(spec) ?? [];
    list.push(file);
    imports.set(spec, list);
  }
}

const report = [...imports.entries()]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([specifier, usedBy]) => ({ specifier, usedBy }));

console.log(JSON.stringify({
  files: files.length,
  imports: report,
  bizportalCoupling: report.filter((item) => item.specifier.startsWith("@/") || item.specifier.startsWith("@shared/"))
}, null, 2));
