import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, readdirSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const modulePath = join(import.meta.dir, '../src/core/page-file-lock.ts');
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'page-file-lock-'));
  const root = join(dir, 'source'); mkdirSync(root);
  return { dir, options: { root, lockDirectory: join(dir, 'locks'), topology: 'single-host-local' as const } };
}

test('separate processes serialize, old mtime cannot steal, SIGKILL releases kernel owner', async () => {
  const api = await import(modulePath); const f = fixture();
  const options = { ...f.options, paths: ['b.md', 'a.md', 'a.md'] };
  const child = Bun.spawn([process.execPath, '-e', `
    import { acquirePageFileLock } from ${JSON.stringify(modulePath)};
    const handle = await acquirePageFileLock(${JSON.stringify(options)});
    if (!handle) process.exit(2);
    console.log('held');
    setInterval(() => {}, 1000);
  `], { stdout: 'pipe', stderr: 'pipe', env: { PATH: process.env.PATH } });
  try {
    const reader = child.stdout.getReader();
    const ready = await reader.read(); reader.releaseLock();
    expect(new TextDecoder().decode(ready.value).trim()).toBe('held');
    const files = readdirSync(f.options.lockDirectory).map(p => join(f.options.lockDirectory, p));
    const inodes = files.map(p => statSync(p).ino);
    for (const file of files) utimesSync(file, new Date(0), new Date(0));
    expect(await api.acquirePageFileLock({ ...options, paths: ['a.md', 'b.md'], timeoutMs: 30 })).toBeNull();
    expect(await api.acquirePageFileLock({ ...f.options, rootMode: 'exclusive' })).toBeNull();
    const distinct = await api.acquirePageFileLock({ ...f.options, paths: ['c.md'] });
    expect(distinct).not.toBeNull(); await distinct.release();
    const otherRoot = join(f.dir, 'other'); mkdirSync(otherRoot);
    const other = await api.acquirePageFileLock({ ...options, root: otherRoot });
    expect(other).not.toBeNull(); await other.release();
    child.kill('SIGKILL'); await child.exited;
    const recovered = await api.acquirePageFileLock({ ...options, timeoutMs: 100 });
    expect(recovered).not.toBeNull(); await recovered.release();
    expect(files.map(p => statSync(p).ino)).toEqual(inodes);
  } finally {
    child.kill('SIGKILL'); await child.exited;
    rmSync(f.dir, { recursive: true, force: true });
  }
}, 3000);

test('lock directory inside mutable root is refused', async () => {
  const api = await import(modulePath); const f = fixture();
  try {
    await expect(api.acquirePageFileLock({ ...f.options, lockDirectory: join(f.options.root, '.locks') })).rejects.toThrow('outside');
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('partial acquisition timeout releases earlier path and root locks', async () => {
  const api = await import(modulePath); const f = fixture();
  try {
    const blocker = await api.acquirePageFileLock({ ...f.options, paths: ['b.md'] });
    expect(await api.acquirePageFileLock({ ...f.options, paths: ['b.md', 'a.md'], timeoutMs: 25 })).toBeNull();
    const first = await api.acquirePageFileLock({ ...f.options, paths: ['a.md'] });
    expect(first).not.toBeNull(); await first.release(); await blocker.release();
    const exclusive = await api.acquirePageFileLock({ ...f.options, rootMode: 'exclusive' });
    expect(exclusive).not.toBeNull(); await exclusive.release();
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('refuses noncanonical paths and unsupported topology before locking', async () => {
  const api = await import(modulePath); const f = fixture();
  try {
    for (const path of ['../a.md', '/a.md', './a.md', 'x//a.md', 'x/../a.md', '']) {
      await expect(api.acquirePageFileLock({ ...f.options, paths: [path] })).rejects.toThrow('noncanonical');
    }
    await expect(api.acquirePageFileLock({ ...f.options, topology: 'multi-host' })).rejects.toThrow('topology');
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('wait budget retries until a held path is released', async () => {
  const api = await import(modulePath); const f = fixture();
  try {
    const a = await api.acquirePageFileLock({ ...f.options, paths: ['a.md'] });
    const timer = setTimeout(() => { void a.release(); }, 40);
    try {
      const b = await api.acquirePageFileLock({ ...f.options, paths: ['a.md'], timeoutMs: 300 });
      expect(b).not.toBeNull(); await b.release();
    } finally { clearTimeout(timer); await a.release(); }
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('exclusive root mutation waits for shared page gates', async () => {
  const api = await import(modulePath);
  const f = fixture();
  try {
    const a = await api.acquirePageFileLock({ ...f.options, paths: ['a.md'] });
    const b = await api.acquirePageFileLock({ ...f.options, paths: ['b.md'] });
    expect(b).not.toBeNull();
    expect(await api.acquirePageFileLock({ ...f.options, rootMode: 'exclusive' })).toBeNull();
    await a.release(); await b.release();
    const exclusive = await api.acquirePageFileLock({ ...f.options, rootMode: 'exclusive' });
    expect(exclusive).not.toBeNull();
    expect(await api.acquirePageFileLock({ ...f.options, paths: ['c.md'] })).toBeNull();
    await exclusive.release();
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('same-process path ownership cannot be stolen and release is idempotent', async () => {
  const api = await import(modulePath).catch(() => null);
  expect(api).not.toBeNull();
  const f = fixture();
  try {
    const a = await api!.acquirePageFileLock({ ...f.options, paths: ['a.md'] });
    expect(a).not.toBeNull();
    expect(await api!.acquirePageFileLock({ ...f.options, paths: ['a.md'] })).toBeNull();
    await a.release(); await a.release();
    const b = await api!.acquirePageFileLock({ ...f.options, paths: ['a.md'] });
    expect(b).not.toBeNull(); await b.release();
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
