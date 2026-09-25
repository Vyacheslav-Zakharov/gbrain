/**
 * End-to-end durability hook + helper (v0.42.44): the generated bash actually
 * pushes. Real git, local bare remote. Validates the D13 guarantee (helper),
 * the D9 self-contained local hook, and the D7 "one push-retry template" claim
 * (the hook works even with the committed helper deleted).
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { BrainEngine } from '../src/core/engine.ts';

// Only the absent enrollment catalog is synthetic; permit issuance stays real.
const unenrolledRootEngine = {
  async executeRaw(sql: string) {
    if (sql === "SELECT to_regclass('public.page_file_bindings') IS NOT NULL AS present") {
      return [{ present: false }];
    }
    throw new Error(`Unexpected root-gate query: ${sql}`);
  },
} as Pick<BrainEngine, 'executeRaw'>;

import { execFileSync } from 'child_process';
import { hardenBrainRepo } from '../src/core/brain-repo-durability.ts';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'protocol.file.allow=always', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8', env: process.env,
  }).trim();
}
function originHead(bare: string): string {
  return git(bare, 'rev-parse', 'refs/heads/main');
}
async function waitForOrigin(bare: string, expectSha: string, ms = 8000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { if (originHead(bare) === expectSha) return true; } catch { /* */ }
    await new Promise(r => setTimeout(r, 150));
  }
  return false;
}

// Every fixture commit after `init` runs the real post-commit hook. A remote
// SHA alone is not a completion signal: harden also pushes synchronously, while
// its detached hook can still be retrying via our no-host compatibility gate.
// Wait for each hook's terminal log record AND release of its push lock before
// another foreground pull or removal of the fixture tree.
async function drainHookPushes(): Promise<void> {
  const expected = Number(git(work, 'rev-list', '--count', 'HEAD')) - 1 + foregroundPushes;
  const log = join(process.env.GBRAIN_HOME!, 'brain-push.log');
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const text = existsSync(log) ? readFileSync(log, 'utf-8') : '';
    const completed = text.split('\n').filter(line => /\[push\] (ok |ok-after-retry |LOCAL-ONLY,|lock-timeout )/.test(line)).length;
    if (completed >= expected) {
      const lock = join(work, '.git', 'gbrain-push.lock');
      if (existsSync(lock)) execFileSync('flock', ['-w', '2', lock, 'true'], { timeout: 3000 });
      return;
    }
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error(`Hook did not finish ${expected} pushes: ${existsSync(log) ? readFileSync(log, 'utf-8') : 'no log'}`);
}

let root: string, work: string, bare: string;
let foregroundPushes = 0;
let oldHome: string | undefined, oldGbrainHome: string | undefined;
let oldPath: string | undefined;

// Offline CLI boundary: strict argv/root routing, real gate and real Git. This
// deliberately does not claim connected-engine/DB source-route acceptance.
function installOfflinePullCli(): void {
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const gate = new URL('../src/core/page-file-root-gate.ts', import.meta.url).pathname;
  const remote = new URL('../src/core/git-remote.ts', import.meta.url).pathname;
  const script = join(bin, 'pull.ts');
  writeFileSync(script, `
import { withLegacyPageFileRootMutation } from ${JSON.stringify(gate)};
import { divergenceSafePull } from ${JSON.stringify(remote)};
const args = process.argv.slice(2);
if (JSON.stringify(args) !== JSON.stringify(['sources', 'pull', 'wiki', '--branch', 'main']) || process.cwd() !== ${JSON.stringify(work)}) process.exit(64);
const engine = { ${unenrolledRootEngine.executeRaw.toString()} };
const result = await withLegacyPageFileRootMutation(engine, process.cwd(),
  rootPermit => divergenceSafePull(process.cwd(), 'main', { rootPermit }));
if (result.status === 'conflict_aborted') { console.error(result.detail); process.exit(1); }
`);
  writeFileSync(join(bin, 'gbrain'), `#!/bin/sh\nexec '${process.execPath.replace(/'/g, "'\\''")}' '${script.replace(/'/g, "'\\''")}' "$@"\n`, { mode: 0o755 });
  oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath ?? ''}`;
}

beforeEach(async () => {
  foregroundPushes = 0;
  root = mkdtempSync(join(tmpdir(), 'bdh-'));
  oldHome = process.env.HOME; oldGbrainHome = process.env.GBRAIN_HOME;
  process.env.HOME = mkdtempSync(join(root, 'home-'));
  process.env.GBRAIN_HOME = join(process.env.HOME, '.gbrain');
  process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT = '1';
  bare = mkdtempSync(join(root, 'origin-')) + '.git';
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { stdio: 'ignore' });
  work = mkdtempSync(join(root, 'work-'));
  execFileSync('git', ['-c', 'protocol.file.allow=always', 'clone', '-q', bare, work], { stdio: 'ignore' });
  git(work, 'config', 'user.email', 't@t.t'); git(work, 'config', 'user.name', 'tester');
  writeFileSync(join(work, 'README.md'), 'init\n');
  git(work, 'add', 'README.md'); git(work, 'commit', '-qm', 'init'); git(work, 'push', '-q', 'origin', 'main');
  git(work, 'remote', 'set-head', 'origin', 'main');
  installOfflinePullCli();
  await hardenBrainRepo({ engine: unenrolledRootEngine, repoPath: work, sourceId: 'wiki', pat: 'ghp_x', installCron: false });
  expect(git(bare, 'rev-parse', '--is-bare-repository')).toBe('true');
  await drainHookPushes();
});
afterEach(async () => {
  try {
    await drainHookPushes();
  } finally {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldGbrainHome === undefined) delete process.env.GBRAIN_HOME; else process.env.GBRAIN_HOME = oldGbrainHome;
    delete process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT;
    rmSync(root, { recursive: true, force: true });
  }
});

describe('brain-commit-push.sh (D13 guarantee)', () => {
  test('add → commit → push lands on origin', () => {
    mkdirSync(join(work, 'people'), { recursive: true });
    writeFileSync(join(work, 'people', 'alice.md'), '# alice\n');
    // helper requires explicit path; stages people/alice.md
    foregroundPushes++;
    execFileSync('bash', [join(work, 'scripts', 'brain-commit-push.sh'), 'add alice', 'people/alice.md'], {
      cwd: work, stdio: ['ignore', 'pipe', 'pipe'], env: process.env,
    });
    expect(originHead(bare)).toBe(git(work, 'rev-parse', 'HEAD'));
    // origin actually has the file
    const verify = mkdtempSync(join(root, 'verify-'));
    execFileSync('git', ['-c', 'protocol.file.allow=always', 'clone', '-q', bare, verify], { stdio: 'ignore' });
    expect(existsSync(join(verify, 'people', 'alice.md'))).toBe(true);
  });

  test('refuses success when the push cannot land (exit non-zero)', () => {
    git(work, 'remote', 'set-url', 'origin', join(root, 'gone.git'));
    writeFileSync(join(work, 'x.md'), 'x\n');
    foregroundPushes++;
    let code = 0;
    try {
      execFileSync('bash', [join(work, 'scripts', 'brain-commit-push.sh'), 'msg', 'x.md'], {
        cwd: work, stdio: ['ignore', 'pipe', 'pipe'], env: process.env,
      });
    } catch (e: any) { code = e.status ?? 1; }
    expect(code).not.toBe(0); // committed but push failed → loud failure
  });

  test('refuses a blind add (no explicit path)', () => {
    let code = 0;
    try {
      execFileSync('bash', [join(work, 'scripts', 'brain-commit-push.sh'), 'msg'], {
        cwd: work, stdio: ['ignore', 'pipe', 'pipe'], env: process.env,
      });
    } catch (e: any) { code = e.status ?? 1; }
    expect(code).toBe(2);
  });
});

describe('post-commit hook (D9 local, D7 self-contained)', () => {
  test('a direct commit auto-pushes in the background', async () => {
    writeFileSync(join(work, 'note.md'), 'note\n');
    git(work, 'add', 'note.md'); git(work, 'commit', '-qm', 'note'); // fires .git/hooks/post-commit
    const head = git(work, 'rev-parse', 'HEAD');
    expect(await waitForOrigin(bare, head)).toBe(true);
  });

  test('the hook works even with the committed helper deleted (self-contained)', async () => {
    rmSync(join(work, 'scripts', 'brain-commit-push.sh'));
    git(work, 'add', '-A'); git(work, 'commit', '-qm', 'remove helper');
    const head = git(work, 'rev-parse', 'HEAD');
    expect(await waitForOrigin(bare, head)).toBe(true);
  });

  test('logs a clear LOCAL-ONLY line when origin is unreachable', async () => {
    git(work, 'remote', 'set-url', 'origin', join(root, 'gone2.git'));
    writeFileSync(join(work, 'orphan.md'), 'o\n');
    git(work, 'add', 'orphan.md'); git(work, 'commit', '-qm', 'orphan');
    const log = join(process.env.GBRAIN_HOME!, 'brain-push.log');
    const deadline = Date.now() + 8000;
    let found = false;
    while (Date.now() < deadline) {
      if (existsSync(log) && readFileSync(log, 'utf-8').includes('NEEDS ATTENTION')) { found = true; break; }
      await new Promise(r => setTimeout(r, 150));
    }
    expect(found).toBe(true);
  });
});
