import { beforeAll, afterAll, expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { acquirePageFileLock } from '../src/core/page-file-lock.ts';
import { writePageThrough } from '../src/core/write-through.ts';
import { PageFileDatabase } from '../src/core/page-file-db.ts';
import { withPageFileEnrollment } from '../src/core/page-file-enrollment.ts';

 test('real enrollment excludes unrelated legacy paths until transaction commit completes', async () => {
  await writeFile(join(root, 'example.md'), 'Before');
  const entered = barrier(); const resume = barrier();
  const service = new PageFileDatabase(engine, { brainId: 'fixture', journalDirectory: join(dir, 'journal'),
    withLockedBinding: fn => withPageFileEnrollment(engine, 'default', host, async () => {
      const result = await fn(); entered.release(); await resume.promise; return result;
    }) });
  const enrolling = service.enroll('default', 'example');
  try {
    await entered.promise;
    expect(await engine.executeRaw('SELECT * FROM page_file_bindings')).toHaveLength(1);
    expect(await acquirePageFileLock({ ...host, paths: ['unrelated.md'] })).toBeNull();
    expect(await writePageThrough(engine, 'example', { coordinationHost: host })).toMatchObject({ written: false, error: 'page_file_gate_busy' });
  } finally { resume.release(); }
  await enrolling;
  expect(await writePageThrough(engine, 'example', { coordinationHost: host })).toMatchObject({ written: false, error: 'page_file_unsupported_writer' });
  await engine.executeRaw('DELETE FROM page_file_bindings');
});

test('write-through rejects a containing but different coordination root', async () => {
  expect(await writePageThrough(engine, 'example', { coordinationHost: { ...host, root: dir } }))
    .toMatchObject({ written: false, error: 'page_file_binding_changed' });
});

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

test('explicit enrollment waits outside DB while real write-through is paused after absence check', async () => {
  const enrollment = await import('../src/core/page-file-enrollment.ts').catch(() => ({} as any));
  expect(typeof enrollment.withPageFileEnrollment).toBe('function');
  const entered = barrier(); const resume = barrier();
  const original = engine.getTags.bind(engine);
  engine.getTags = async (...args) => { entered.release(); await resume.promise; return original(...args); };
  const writing = writePageThrough(engine, 'example', { coordinationHost: host });
  try {
    await entered.promise;
    const service = new PageFileDatabase(engine, { brainId: 'fixture', journalDirectory: join(dir, 'journal'),
      withLockedBinding: fn => enrollment.withPageFileEnrollment(engine, 'default', host, fn) });
    await expect(service.enroll('default', 'example')).rejects.toThrow('page_file_gate_busy');
    expect(await engine.executeRaw('SELECT * FROM page_file_bindings')).toHaveLength(0);
  } finally { resume.release(); engine.getTags = original; }
  expect((await writing).written).toBe(true);
});

let engine: PGLiteEngine; let dir: string; let root: string;
let host: { root: string; lockDirectory: string; topology: 'single-host-local' };
beforeAll(async () => {
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  dir = await mkdtemp(join(tmpdir(), 'enrollment-')); root = join(dir, 'root'); await mkdir(root);
  host = { root, lockDirectory: join(dir, 'locks'), topology: 'single-host-local' };
  await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [root]);
  await engine.putPage('example', { type: 'concept', title: 'Example', compiled_truth: 'Before', timeline: '', frontmatter: {} });
  await writeFile(join(root, 'example.md'), 'Before');
});
afterAll(async () => { await engine.disconnect(); await rm(dir, { recursive: true, force: true }); });

test('real write-through refuses while enrollment owns exclusive root', async () => {
  const before = await readFile(join(root, 'example.md'), 'utf8');
  const lock = await acquirePageFileLock({ ...host, rootMode: 'exclusive' });
  try {
    const result = await writePageThrough(engine, 'example', { coordinationHost: host });
    expect(result).toMatchObject({ written: false, error: 'page_file_gate_busy' });
    expect(await readFile(join(root, 'example.md'), 'utf8')).toBe(before);
  } finally { await lock!.release(); }
});
