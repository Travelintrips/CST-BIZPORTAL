import { readFile, readdir } from "node:fs/promises";
import { resolve, basename } from "node:path";
import { createHash } from "node:crypto";

const root = resolve(import.meta.dirname, "../../..");
const sourceDir = resolve(root, "artifacts/bizportal/src/pages/logistics/fleet-intelligence");
const snapshotDir = resolve(root, "standalone/fleet-intelligence/source/frontend/pages");

const hash = (value) => createHash("sha256").update(value).digest("hex");
const names = (await readdir(sourceDir)).filter((name) => name.endsWith(".tsx")).sort();

const mismatches = [];
for (const name of names) {
  const [source, snapshot] = await Promise.all([
    readFile(resolve(sourceDir, name), "utf8"),
    readFile(resolve(snapshotDir, name), "utf8").catch(() => null),
  ]);
  if (snapshot === null || hash(source) !== hash(snapshot)) mismatches.push(name);
}

const extra = (await readdir(snapshotDir))
  .filter((name) => name.endsWith(".tsx") && !names.includes(name))
  .sort();

if (mismatches.length || extra.length) {
  console.error(JSON.stringify({ ok: false, mismatches, extra }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, files: names.length, source: basename(sourceDir) }, null, 2));
