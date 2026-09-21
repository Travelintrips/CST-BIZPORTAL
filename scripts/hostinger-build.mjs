#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PNPM_VERSION = "10.33.0";
const workspaceToolRoot = path.join(repoRoot, ".hostinger-tools");
const homeToolRoot = path.join(
  os.homedir(),
  ".cache",
  "cst-bizportal",
  "hostinger-tools",
);

function isNpmInvocation() {
  return process.env.npm_config_user_agent?.startsWith("npm/") ?? false;
}

function uniquePaths(paths) {
  const systemTempRoot = path.resolve(os.tmpdir());
  return [
    ...new Set(
      paths
        .filter(Boolean)
        .map((candidate) => path.resolve(candidate))
        .filter(
          (candidate) =>
            candidate !== systemTempRoot &&
            !candidate.startsWith(`${systemTempRoot}${path.sep}`),
        ),
    ),
  ];
}

function runNodeScript(script, args, environment, stdio = "inherit") {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    env: environment,
    stdio,
  });
}

function runCommand(command, args, environment) {
  return spawnSync(command, args, {
    cwd: repoRoot,
    env: environment,
    stdio: "inherit",
  });
}

async function createBuildEnvironment(toolRoot) {
  const tempRoot = path.join(toolRoot, "tmp");
  const npmCacheRoot = path.join(toolRoot, "npm-cache");
  await mkdir(tempRoot, { recursive: true });
  await mkdir(npmCacheRoot, { recursive: true });

  const environment = {
    ...process.env,
    TMPDIR: tempRoot,
    TMP: tempRoot,
    TEMP: tempRoot,
    npm_config_cache: npmCacheRoot,
  };
  delete environment.ESBUILD_BINARY_PATH;
  delete environment.npm_config_esbuild_binary_path;
  return environment;
}

async function isUsablePnpm(entryPoint, environment) {
  const result = runNodeScript(entryPoint, ["--version"], environment, "ignore");
  return result.status === 0;
}

async function installPnpm(toolRoot, environment) {
  const installRoot = path.join(toolRoot, `pnpm-${PNPM_VERSION}`);
  await mkdir(installRoot, { recursive: true });
  const result = runCommand(
    "npm",
    [
      "install",
      "--prefix",
      installRoot,
      "--no-save",
      "--no-package-lock",
      "--ignore-scripts",
      `pnpm@${PNPM_VERSION}`,
    ],
    environment,
  );
  if (result.status !== 0) {
    throw new Error(`npm could not install pnpm ${PNPM_VERSION}`);
  }
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

async function addPnpmToPath(toolRoot, entryPoint, environment) {
  const binRoot = path.join(toolRoot, `pnpm-${PNPM_VERSION}`, "bin");
  const wrapperPath = path.join(binRoot, "pnpm");
  await mkdir(binRoot, { recursive: true });
  await writeFile(
    wrapperPath,
    `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(entryPoint)} "$@"\n`,
    { mode: 0o755 },
  );

  return {
    ...environment,
    PATH: `${binRoot}${path.delimiter}${environment.PATH ?? ""}`,
  };
}

async function resolvePnpmRunner() {
  const toolRoots = uniquePaths([
    process.env.HOSTINGER_BUILD_TOOLS_DIR,
    workspaceToolRoot,
    homeToolRoot,
  ]);
  const failures = [];

  for (const toolRoot of toolRoots) {
    const entryPoint = path.join(
      toolRoot,
      `pnpm-${PNPM_VERSION}`,
      "node_modules",
      "pnpm",
      "bin",
      "pnpm.cjs",
    );

    try {
      const environment = await createBuildEnvironment(toolRoot);
      if (!(await isUsablePnpm(entryPoint, environment))) {
        await installPnpm(toolRoot, environment);
      }

      const runnerEnvironment = await addPnpmToPath(
        toolRoot,
        entryPoint,
        environment,
      );
      if (await isUsablePnpm(entryPoint, runnerEnvironment)) {
        return { entryPoint, environment: runnerEnvironment };
      }
      failures.push(`${toolRoot}: pnpm did not pass its version check`);
    } catch (error) {
      failures.push(
        `${toolRoot}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  throw new Error(
    [
      `Could not bootstrap pnpm ${PNPM_VERSION} in an executable workspace/home location.`,
      ...failures,
    ].join("\n"),
  );
}

async function runBuild() {
  if (!isNpmInvocation()) {
    const environment = await createBuildEnvironment(workspaceToolRoot);
    const result = runCommand(
      process.env.PNPM_BIN ?? "pnpm",
      ["run", "build:workspace"],
      environment,
    );
    process.exitCode = result.status ?? 1;
    return;
  }

  const { entryPoint, environment } = await resolvePnpmRunner();
  const installResult = runNodeScript(
    entryPoint,
    ["install", "--frozen-lockfile"],
    environment,
  );
  if (installResult.status !== 0) {
    process.exitCode = installResult.status ?? 1;
    return;
  }

  const buildResult = runNodeScript(
    entryPoint,
    ["run", "build:workspace"],
    environment,
  );
  process.exitCode = buildResult.status ?? 1;
}

await runBuild();