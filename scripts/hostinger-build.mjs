import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { stdio: 'inherit', env });
  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
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
      const target = path.join(os.tmpdir(), `bizportal-esbuild-${process.pid}`);
      fs.copyFileSync(source, target);
      fs.chmodSync(target, 0o755);
      console.log(`[hostinger-build] Using executable esbuild copy: ${target}`);
      run(target, ['--version'], buildEnv);
      buildEnv.ESBUILD_BINARY_PATH = target;
    }
  }
}

run(pnpm[0], [...pnpm[1], 'run', 'build:workspace'], buildEnv);
