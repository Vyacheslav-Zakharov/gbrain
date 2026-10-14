import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { withExclusiveSourceWrites, withSourceWrites } from '../src/core/write-admission.ts';

// Registry-only engine: locking itself is real kernel flock, not mocked.
function registry(path: string): BrainEngine {
  return { executeRaw: async () => [{ id: 'shared', local_path: path }] } as unknown as BrainEngine;
}
test('real child shared writer drains; timeout leaves no gate; crash releases ownership', async () => {
  const path = mkdtempSync(join(tmpdir(), 'gbrain-admission-process-'));
  const engine = registry(path);
  const child = Bun.spawn([process.execPath, join(import.meta.dir, 'fixtures/write-admission-holder.ts'), path, 'shared'], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  try {
    const reader = child.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('ADMITTED');
    reader.releaseLock();
    await expect(withExclusiveSourceWrites(engine, ['shared'], async () => {}, { timeoutMs: 30 })).rejects.toMatchObject({ code: 'SOURCE_WRITE_BUSY' });
    await withSourceWrites(engine, ['shared'], async () => {}); // timed-out exclusive gate closed
    let entered = false;
    const exclusive = withExclusiveSourceWrites(engine, ['shared'], async () => { entered = true; }, { timeoutMs: 1000 });
    await Bun.sleep(40);
    expect(entered).toBe(false);
    await expect(withSourceWrites(engine, ['shared'], async () => {})).rejects.toMatchObject({ code: 'SOURCE_WRITE_BUSY' });
    child.kill('SIGKILL');
    await child.exited;
    await exclusive;
    expect(entered).toBe(true);
    await withSourceWrites(engine, ['shared'], async () => {});
  } finally { child.kill(); await child.exited; rmSync(path, { recursive: true, force: true }); }
});

test('real child exclusive crash releases kernel locks; separate repository remains writable', async () => {
  const path = mkdtempSync(join(tmpdir(), 'gbrain-admission-crash-'));
  const other = mkdtempSync(join(tmpdir(), 'gbrain-admission-other-'));
  const child = Bun.spawn([process.execPath, join(import.meta.dir, 'fixtures/write-admission-holder.ts'), path, 'exclusive'], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  try {
    const reader = child.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('ADMITTED'); reader.releaseLock();
    await expect(withSourceWrites(registry(path), ['shared'], async () => {})).rejects.toMatchObject({ code: 'SOURCE_WRITE_BUSY' });
    await withSourceWrites(registry(other), ['shared'], async () => {});
    child.kill('SIGKILL'); await child.exited;
    await withExclusiveSourceWrites(registry(path), ['shared'], async () => {});
  } finally { child.kill(); await child.exited; rmSync(path, { recursive: true, force: true }); rmSync(other, { recursive: true, force: true }); }
});

test('durable exclusive error keeps write refusal until explicit recovery succeeds', async () => {
  const path = mkdtempSync(join(tmpdir(), 'gbrain-admission-durable-'));
  const engine = registry(path);
  try {
    await expect(withExclusiveSourceWrites(engine, ['shared'], async () => { throw new Error('publication uncertain'); }, { durable: true })).rejects.toThrow('publication uncertain');
    await expect(withSourceWrites(engine, ['shared'], async () => {})).rejects.toMatchObject({ code: 'SOURCE_WRITE_BUSY' });
    const { recoverSourceWrites } = await import('../src/core/write-admission.ts');
    await expect(recoverSourceWrites(engine, ['shared'], async () => { throw new Error('children not settled'); })).rejects.toThrow('children not settled');
    await expect(withSourceWrites(engine, ['shared'], async () => {})).rejects.toMatchObject({ code: 'SOURCE_WRITE_BUSY' });
    await recoverSourceWrites(engine, ['shared'], async () => {});
    await withSourceWrites(engine, ['shared'], async () => {});
  } finally { rmSync(path, { recursive: true, force: true }); }
});

test('durable holder SIGKILL leaves marker; clean recovery reopens writers', async () => {
  const path = mkdtempSync(join(tmpdir(), 'gbrain-admission-durable-kill-'));
  const engine = registry(path);
  const child = Bun.spawn([process.execPath, join(import.meta.dir, 'fixtures/write-admission-holder.ts'), path, 'durable'], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  try {
    const reader = child.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('ADMITTED'); reader.releaseLock();
    child.kill('SIGKILL'); await child.exited;
    await expect(withSourceWrites(engine, ['shared'], async () => {})).rejects.toMatchObject({ code: 'SOURCE_WRITE_BUSY' });
    await expect(withExclusiveSourceWrites(engine, ['shared'], async () => {})).rejects.toMatchObject({ code: 'SOURCE_WRITE_BUSY' });
    const { recoverSourceWrites } = await import('../src/core/write-admission.ts');
    await recoverSourceWrites(engine, ['shared'], async () => {});
    await withExclusiveSourceWrites(engine, ['shared'], async () => {
      await withSourceWrites(engine, ['shared'], async () => {});
    }, { durable: true });
    await withSourceWrites(engine, ['shared'], async () => {});
  } finally { child.kill(); await child.exited; rmSync(path, { recursive: true, force: true }); }
});

test('escaped async context expires instead of reusing released exclusive permission', async () => {
  const path = mkdtempSync(join(tmpdir(), 'gbrain-admission-expired-'));
  const engine = registry(path);
  let proceed!: () => void;
  const wait = new Promise<void>(r => proceed = r);
  let escaped!: Promise<void>;
  try {
    await withExclusiveSourceWrites(engine, ['shared'], async () => {
      escaped = (async () => { await wait; await withSourceWrites(engine, ['shared'], async () => {}); })();
    });
    proceed();
    await expect(escaped).rejects.toThrow('Expired write admission context');
  } finally { rmSync(path, { recursive: true, force: true }); }
});

test('nested source aliases and fallback share the same physical Git lock', async () => {
  const { mkdirSync, symlinkSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const root = mkdtempSync(join(tmpdir(), 'gbrain-admission-alias-'));
  const repo = join(root, 'repo'), nested = join(repo, 'nested'), alias = join(root, 'alias');
  mkdirSync(nested, { recursive: true }); symlinkSync(repo, alias);
  execFileSync('/usr/bin/git', ['init', '-q', repo]);
  const engine = { executeRaw: async () => [{ id: 'shared', local_path: repo }, { id: 'nested', local_path: nested }, { id: 'alias', local_path: alias }, { id: 'fallback', local_path: null }], getConfig: async () => repo } as unknown as BrainEngine;
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(r => entered = r), stop = new Promise<void>(r => release = r);
  const holder = withExclusiveSourceWrites(engine, ['shared'], async () => { entered(); await stop; });
  try {
    await ready;
    for (const id of ['nested', 'alias', 'fallback']) await expect(withSourceWrites(engine, [id], async () => {})).rejects.toMatchObject({ code: 'SOURCE_WRITE_BUSY' });
  } finally { release(); await holder; rmSync(root, { recursive: true, force: true }); }
});

test('exclusive rejects missing source rather than running unfenced', async () => {
  const engine = { executeRaw: async () => [] } as unknown as BrainEngine;
  let effects = 0;
  await expect(withExclusiveSourceWrites(engine, ['missing'], async () => { effects++; })).rejects.toThrow();
  expect(effects).toBe(0);
});

test('exclusive admits nested importer but refuses independent mutation before callback', async () => {
  const path = mkdtempSync(join(tmpdir(), 'gbrain-admission-'));
  const engine = registry(path);
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>(r => entered = r);
  const stop = new Promise<void>(r => release = r);
  let effects = 0;
  const holder = withExclusiveSourceWrites(engine, ['shared'], async () => {
    await withSourceWrites(engine, ['shared'], async () => { effects++; });
    entered();
    await stop;
  });
  try {
    await ready;
    await expect(withSourceWrites(engine, ['shared'], async () => { effects++; })).rejects.toMatchObject({ code: 'SOURCE_WRITE_BUSY' });
    expect(effects).toBe(1);
  } finally { release(); await holder; rmSync(path, { recursive: true, force: true }); }
});
