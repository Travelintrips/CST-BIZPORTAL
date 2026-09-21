import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { stdio: 'inherit', env });
  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
}

function canExecute(command, env) {
  const result = spawnSync(command, ['--version'], { stdio: 'inherit', env });
  return !result.error && (result.status ?? 1) === 0;
}

const ua = process.env.npm_config_user_agent || '';
const viaNpm = ua.startsWith('npm/');
const pnpm = viaNpm
  ? ['npx', ['--yes', 'pnpm@10.33.0']]
  : ['pnpm', []];

if (viaNpm) {
  run(pnpm[0], [...pnpm[1], 'install', '--frozen-lockfile']);
}

let buildEnv = { ...process.env };
const pnpmStore = path.join(process.cwd(), 'node_modules', '.pnpm');

if (fs.existsSync(pnpmStore)) {
  const platformEntry = fs.readdirSync(pnpmStore).find((name) =>
    name.startsWith('@esbuild+linux-x64@')
  );

  if (platformEntry) {
    const source = path.join(
      pnpmStore,
      platformEntry,
      'node_modules',
      '@esbuild',
      'linux-x64',
      'bin',
      'esbuild'
    );

    if (fs.existsSync(source)) {
      let executable = null;

      try {
        fs.chmodSync(source, 0o755);
        if (canExecute(source, buildEnv)) {
          executable = source;
        }
      } catch (error) {
        console.warn('[hostinger-build] Direct esbuild execution unavailable:', error.message);
      }

      if (!executable) {
        const cacheDir = path.join(os.homedir(), '.cache', 'bizportal-hostinger');
        fs.mkdirSync(cacheDir, { recursive: true });
        const target = path.join(cacheDir, `esbuild-${process.pid}`);
        fs.copyFileSync(source, target);
        fs.chmodSync(target, 0o755);

        if (!canExecute(target, buildEnv)) {
          throw new Error(`Unable to execute esbuild from Hostinger cache path: ${target}`);
        }

        executable = target;
      }

      console.log(`[hostinger-build] Using executable esbuild: ${executable}`);
      buildEnv.ESBUILD_BINARY_PATH = executable;
    }
  }
}

run(pnpm[0], [...pnpm[1], 'run', 'build:workspace'], buildEnv);
