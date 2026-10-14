import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { BrainEngine } from '../src/core/engine.ts';
import { withExclusiveSourceWrites, recoverSourceWrites } from '../src/core/write-admission.ts';

const cli = resolve(import.meta.dir, '../src/cli.ts');
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-entrypoint-'));
  const repo = join(root, 'repo'), home = join(root, 'home');
  mkdirSync(repo); mkdirSync(home); mkdirSync(join(home, '.gbrain'));
  execFileSync('/usr/bin/git', ['init', '-q', repo]);
  writeFileSync(join(home, '.gbrain/config.json'), JSON.stringify({ engine: 'pglite' }));
  const engine = { executeRaw: async () => [{ id: 'shared', local_path: repo }] } as unknown as BrainEngine;
  const env = { ...process.env, HOME: home, GBRAIN_HOME: home, DATABASE_URL: undefined,
    GBRAIN_DATABASE_URL: undefined, GBRAIN_SOURCE: undefined, GBRAIN_BRAIN_ID: undefined };
  return { root, repo, home, engine, env };
}
async function run(f: ReturnType<typeof fixture>, args: string[], preload?: string) {
  const p = Bun.spawn([process.execPath, ...(preload ? ['--preload', preload] : []), cli, ...args], {
    cwd: f.root, env: f.env, stdout: 'pipe', stderr: 'pipe',
  });
  const timer = setTimeout(() => p.kill('SIGKILL'), 10000);
  try {
    const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { code, out, err };
  } finally { clearTimeout(timer); }
}

function fakeEnginePreload(f: ReturnType<typeof fixture>) {
  const preload = join(f.root, 'preload.ts');
  const core = resolve(import.meta.dir, '../src/core');
  writeFileSync(preload, `
    import { mock } from 'bun:test';
    import { appendFileSync } from 'node:fs';
    const record = (s) => appendFileSync(${JSON.stringify(join(f.root, 'effects'))}, s + '\\n');
    const row = { id: 'shared', name: 'shared', local_path: ${JSON.stringify(f.repo)}, config: {}, page_count: 0 };
    const engine = {
      kind: 'postgres', connect: async () => {}, disconnect: async () => {},
      getConfig: async () => null, getAllConfig: async () => ({}),
      executeRaw: async (sql) => {
        if (/^\\s*(DELETE|UPDATE|INSERT)/i.test(sql)) { record('SQL:' + sql); return []; }
        if (sql.includes('FROM sources')) return [row];
        return [{ count: 0 }];
      },
    };
    mock.module(${JSON.stringify(join(core, 'engine-factory.ts'))}, () => ({ createEngine: async () => engine }));
    mock.module(${JSON.stringify(join(core, 'migrate.ts'))}, () => ({ tryRunPendingMigrations: async () => ({ status: 'not_needed' }) }));
    mock.module(${JSON.stringify(join(core, 'brain-repo-durability.ts'))}, () => ({ unhardenBrainRepo: async () => record('TEARDOWN') }));
  `);
  return preload;
}

test('actual sources remove --timeout refuses before teardown/SQL with a fake engine only', async () => {
  const f = fixture();
  const preload = fakeEnginePreload(f);
  const args = ['sources', 'remove', 'shared', '--yes', '--confirm-destructive', '--timeout=30s'];
  try {
    await withExclusiveSourceWrites(f.engine, ['shared'], async () => {
      const result = await run(f, args, preload);
      expect(result.err).toMatch(/reserved|paused/i);
      expect(result.code).not.toBe(0);
      expect(existsSync(join(f.root, 'effects'))).toBe(false);
      expect((await run(f, ['sources', 'list', '--timeout=30s'], preload)).code).toBe(0);
    });
    const allowed = await run(f, args, preload);
    expect(allowed.code).toBe(0);
    expect(readFileSync(join(f.root, 'effects'), 'utf8')).toContain('TEARDOWN');
    expect(readFileSync(join(f.root, 'effects'), 'utf8')).toContain('DELETE FROM sources');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
}, 30000);

test('actual sync --watch releases between ticks and protects post-sync gitignore', async () => {
  const f = fixture();
  const preload = fakeEnginePreload(f);
  const core = resolve(import.meta.dir, '../src/core');
  writeFileSync(preload, readFileSync(preload, 'utf8') + `
    import { spawnSync } from 'node:child_process';
    const locks = await import(${JSON.stringify(join(core, 'db-lock.ts'))});
    mock.module(${JSON.stringify(join(core, 'db-lock.ts'))}, () => ({ ...locks,
      withRefreshingLock: async () => ({ status: 'up_to_date' }),
    }));
    const storage = await import(${JSON.stringify(join(core, 'storage-config.ts'))});
    mock.module(${JSON.stringify(join(core, 'storage-config.ts'))}, () => ({ ...storage,
      loadStorageConfig: () => {
        const probe = spawnSync('/usr/bin/flock', ['-n', ${JSON.stringify(join(f.repo, '.git/.gbrain-write-admission.writers'))}, '/usr/bin/true']);
        record('GITIGNORE_EXCLUSIVE:' + probe.status);
        return { db_only: ['private/'], git: [] };
      },
    }));
  `);
  const child = Bun.spawn([process.execPath, '--preload', preload, cli, 'sync', '--watch', '--interval', '60',
    '--source', 'shared', '--repo', f.repo, '--no-pull', '--no-embed', '--no-extract', '--no-hard-deadline'],
    { cwd: f.root, env: { ...f.env, GBRAIN_NO_GITIGNORE: undefined }, stdout: 'pipe', stderr: 'pipe' });
  const output = new Response(child.stdout).text(), errors = new Response(child.stderr).text();
  try {
    const deadline = Date.now() + 10000;
    while (!existsSync(join(f.repo, '.gitignore')) && Date.now() < deadline && child.exitCode === null) {
      await Bun.sleep(20);
    }
    expect(existsSync(join(f.repo, '.gitignore'))).toBe(true);
    expect(readFileSync(join(f.root, 'effects'), 'utf8')).toContain('GITIGNORE_EXCLUSIVE:1');
    await withExclusiveSourceWrites(f.engine, ['shared'], async () => {
      expect(child.exitCode).toBe(null); // daemon still alive, but idle
    }, { timeoutMs: 1000 });
  } finally {
    child.kill('SIGKILL'); await child.exited;
    const out = await output, err = await errors;
    if (!existsSync(join(f.repo, '.gitignore'))) console.error(out, err);
    rmSync(f.root, { recursive: true, force: true });
  }
}, 15000);

for (const command of ['lint', 'check-backlinks']) {
  test(`actual ${command} filesystem writer refuses held exclusive and retained marker outside cwd; reads remain open`, async () => {
    const f = fixture();
    mkdirSync(join(f.repo, 'people'));
    const page = command === 'lint' ? join(f.repo, 'sample.md') : join(f.repo, 'people/alice-example.md');
    const before = command === 'lint' ? '```markdown\n# Example\nText\n```\n' : '# Alice Example\n';
    writeFileSync(page, before);
    writeFileSync(join(f.repo, 'reference.md'), '# Reference\n[Alice Example](people/alice-example.md)\n');
    const args = command === 'lint' ? ['lint', page, '--fix'] : ['check-backlinks', 'fix', '--dir', f.repo];
    const check = async () => {
      const result = await run(f, args);
      expect(result.code).not.toBe(0);
      expect(result.err).toMatch(/reserved|recovery|paused/i);
      expect(readFileSync(page, 'utf8')).toBe(before);
      const read = await run(f, [...args, '--dry-run']);
      expect(read.code).toBe(0);
      const pureRead = await run(f, command === 'lint' ? ['lint', page] : ['check-backlinks', 'check', '--dir', f.repo]);
      expect(pureRead.code).toBe(0);
      expect(readFileSync(page, 'utf8')).toBe(before);
    };
    try {
      await withExclusiveSourceWrites(f.engine, ['shared'], check, { durable: true });
      await expect(withExclusiveSourceWrites(f.engine, ['shared'], async () => { throw new Error('retain'); }, { durable: true })).rejects.toThrow('retain');
      await check();
      expect(existsSync(join(f.repo, '.git/.gbrain-write-admission.recovery'))).toBe(true);
      await recoverSourceWrites(f.engine, ['shared'], async () => {});
      expect((await run(f, args)).code).toBe(0);
      expect(readFileSync(page, 'utf8')).not.toBe(before);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }, 30000);
}
