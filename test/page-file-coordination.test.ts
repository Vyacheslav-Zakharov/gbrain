import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquirePageFileLock } from '../src/core/page-file-lock.ts';
import * as gates from '../src/core/page-file-writer-gate.ts';
import { withLegacyPageFileRootMutation } from '../src/core/page-file-root-gate.ts';
import type { BrainEngine } from '../src/core/engine.ts';

// Native filesystem coordination, with a minimal catalog adapter (no services).
const engine = { executeRaw: async () => [{ present: false }] } as unknown as Pick<BrainEngine, 'executeRaw'>;
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'page-coordination-'));
  const root = join(dir, 'root'); mkdirSync(root);
  return { dir, root, host: { root, lockDirectory: join(dir, 'locks'), topology: 'single-host-local' as const } };
}
test('enrollment exclusive gate prevents even the legacy catalog probe', async () => {
  const f = fixture();
  const enrollment = await acquirePageFileLock({ ...f.host, rootMode: 'exclusive' });
  const forbidden = { executeRaw: async () => { throw new Error('catalog ran outside gate'); } } as unknown as Pick<BrainEngine, 'executeRaw'>;
  try {
    await expect(gates.withLegacyPageFileWrite(forbidden, 's', 'note', join(f.root, 'note.md'), () => { throw new Error('writer ran'); }, f.host)).rejects.toThrow('page_file_gate_busy');
    await expect(withLegacyPageFileRootMutation(forbidden, f.root, () => { throw new Error('writer ran'); }, f.host)).rejects.toThrow('page_file_root_gate_unavailable');
  } finally { await enrollment!.release(); rmSync(f.dir, { recursive: true, force: true }); }
});
test('failed catalog releases file gate without invoking callback', async () => {
  const f = fixture(); let invoked = false;
  const unavailable = { executeRaw: async () => { throw new Error('offline'); } } as unknown as Pick<BrainEngine, 'executeRaw'>;
  try {
    await expect(gates.withLegacyPageFileWrite(unavailable, 's', 'note', join(f.root, 'note.md'), () => { invoked = true; }, f.host)).rejects.toThrow('offline');
    expect(invoked).toBe(false);
    const lock = await acquirePageFileLock({ ...f.host, rootMode: 'exclusive' });
    expect(lock).not.toBeNull(); await lock!.release();
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
test('root callback excludes enrollment and every file even across awaited work', async () => {
  const f = fixture();
  try {
    await withLegacyPageFileRootMutation(engine, f.root, async () => {
      expect(await acquirePageFileLock({ ...f.host, rootMode: 'exclusive' })).toBeNull();
      expect(await acquirePageFileLock({ ...f.host, paths: ['note.md'] })).toBeNull();
      await Promise.resolve();
      throw new Error('callback failed');
    }, f.host).catch(error => { expect(error.message).toBe('callback failed'); });
    const lock = await acquirePageFileLock({ ...f.host, rootMode: 'exclusive' });
    expect(lock).not.toBeNull(); await lock!.release();
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
test('legacy file callback excludes enrollment and same path until async completion', async () => {
  const f = fixture();
  try {
    expect(typeof gates.withLegacyPageFileWrite).toBe('function');
    const result = await gates.withLegacyPageFileWrite(engine, 's', 'note', join(f.root, 'note.md'), async () => {
      expect(await acquirePageFileLock({ ...f.host, rootMode: 'exclusive' })).toBeNull();
      expect(await acquirePageFileLock({ ...f.host, paths: ['note.md'] })).toBeNull();
      const other = await acquirePageFileLock({ ...f.host, paths: ['other.md'] });
      expect(other).not.toBeNull(); await other!.release();
      await Promise.resolve(); return 42;
    }, f.host);
    expect(result).toBe(42);
    const enrollment = await acquirePageFileLock({ ...f.host, rootMode: 'exclusive' });
    expect(enrollment).not.toBeNull(); await enrollment!.release();
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
