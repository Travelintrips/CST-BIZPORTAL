#!/usr/bin/env node

import { cp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const customerPortalRoot = path.resolve(scriptDir, "..");
const workspaceRoot = path.resolve(customerPortalRoot, "../..");
const bizPortalRoot = path.join(workspaceRoot, "artifacts", "bizportal");
const customerPublicDir = path.join(customerPortalRoot, "dist", "public");
const bizPortalPublicDir = path.join(bizPortalRoot, "dist", "public");
const embeddedDir = path.join(customerPublicDir, "bizportal");

console.log("[embed-bizportal] Building the BizPortal bundle for /bizportal/...");

const result = spawnSync(
  "pnpm",
  ["--filter", "@workspace/bizportal", "run", "build"],
  {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      APP_ENV: "production",
      NODE_ENV: "production",
      PORT: process.env.BIZPORTAL_BUILD_PORT ?? "18442",
      BASE_PATH: "/bizportal/",
    },
    stdio: "inherit",
  },
);

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

await rm(embeddedDir, { recursive: true, force: true });
await cp(bizPortalPublicDir, embeddedDir, { recursive: true });

console.log("[embed-bizportal] BizPortal is available at /bizportal/");