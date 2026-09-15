import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, symlink, link, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { PageFileBindingInput } from '../src/core/page-file-binding.ts';

const temps: string[] = [];
afterEach(async () => { await Promise.all(temps.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'gbrain-file-binding-'));
  temps.push(root);
  const raw = Buffer.from('\ufeff---\r\n# preserved comment\r\ntitle: Note\r\n---\r\nBody\r\n');
  await mkdir(join(root, 'notes'));
  await writeFile(join(root, 'notes/original.md'), raw);
  const input: PageFileBindingInput = {
    brainId: 'brain-a', sourceId: 'wiki', slug: 'different-slug', pageId: 'page-1',
    sourcePath: 'notes/original.md', sources: [{ id: 'wiki', local_path: root }],
    globalRepoPath: null, configGeneration: 'config-1', otherPagePaths: [],
  };
  return { root, raw, input };
}
test('legacy roots retain default and .sources/id layout with CJK slug fallback', async () => {
  const { root, raw, input } = await fixture();
  input.sourcePath = null;
  input.slug = '笔记/原文';
  input.globalRepoPath = root;
  for (const id of ['default', 'wiki']) {
    input.sourceId = id;
    input.sources = [{ id, local_path: null }];
    const expectedRoot = id === 'default' ? root : join(root, '.sources', id);
    await mkdir(join(expectedRoot, '笔记'), { recursive: true });
    await writeFile(join(expectedRoot, '笔记/原文.md'), raw);
    const result = await bind(input);
    expect(result.canonicalRoot).toBe(expectedRoot);
    expect(result.absolutePath).toBe(join(expectedRoot, '笔记/原文.md'));
  }
});

test('refuses ambiguous or unsafe server metadata rather than normalizing it', async () => {
  const { input } = await fixture();
  for (const change of [
    { sourceId: '../wiki' }, { sources: [] }, { sources: [...input.sources, ...input.sources] },
    { sourcePath: '../original.md' }, { sourcePath: 'notes/../notes/original.md' },
    { sourcePath: '/etc/passwd' }, { sourcePath: 'notes//original.md' },
    { sourcePath: 'notes/./original.md' }, { sourcePath: '' },
    { sourcePath: 'notes\\\\original.md' }, { sourcePath: 'notes/\u0000.md' },
    { sourcePath: 'C:/original.md' }, { sourcePath: 'notes/original.txt' },
    { pageId: '' }, { brainId: '' }, { configGeneration: '' },
    { sources: [{ id: 'wiki', local_path: 'relative-root' }] },
    { sources: [{ id: 'wiki', local_path: null }], globalRepoPath: null },
  ]) {
    await expect(bind({ ...input, ...change })).rejects.toMatchObject({ code: 'invalid_binding' });
  }
});

test.each(['file-link', 'parent-link', 'root-link', 'root-ancestor-link', 'hardlink', 'missing-file', 'missing-root', 'directory'])('rejects unsafe existing-file topology: %s', async kind => {
  const { root, input } = await fixture();
  const file = join(root, 'notes/original.md');
  let code = 'unsafe_file';
  if (kind === 'file-link') { await rename(file, file + '.real'); await symlink(file + '.real', file); }
  if (kind === 'parent-link') { await rename(join(root, 'notes'), join(root, 'real')); await symlink(join(root, 'real'), join(root, 'notes')); }
  if (kind === 'root-link') { await symlink(root, join(root, 'alias')); input.sources = [{ id: 'wiki', local_path: join(root, 'alias') }]; }
  if (kind === 'root-ancestor-link') { await symlink(root, join(root, 'alias')); input.sources = [{ id: 'wiki', local_path: join(root, 'alias', 'notes') }]; input.sourcePath = 'original.md'; }
  if (kind === 'hardlink') await link(file, file + '.alias');
  if (kind === 'missing-file') { await rm(file); code = 'missing_file'; }
  if (kind === 'missing-root') { input.sources = [{ id: 'wiki', local_path: join(root, 'absent') }]; code = 'missing_file'; }
  if (kind === 'directory') { await rm(file); await mkdir(file); }
  await expect(bind(input)).rejects.toMatchObject({ code });
});

test.each(['same-root', 'nested-owner', 'legacy-global-owner', 'alias-owner', 'duplicate-page'])('refuses conflicting path ownership: %s', async kind => {
  const { root, input } = await fixture();
  if (kind === 'duplicate-page') {
    input.otherPagePaths = [{ pageId: 'page-2', sourceId: 'wiki', sourcePath: 'notes/original.md' }];
  } else {
    let other = root;
    if (kind === 'nested-owner') other = join(root, 'notes');
    if (kind === 'alias-owner') { other = join(root, 'alias'); await symlink(root, other); }
    input.sources = [...input.sources, { id: 'other', local_path: other }];
    if (kind === 'legacy-global-owner') {
      input.sources = [{ id: 'wiki', local_path: null }, { id: 'other', local_path: root }];
      input.globalRepoPath = root;
    }
  }
  await expect(bind(input)).rejects.toMatchObject({ code: 'path_collision' });
});

test('bounds original reads and rejects invalid UTF-8', async () => {
  const { root, raw, input } = await fixture();
  await expect(bind({ ...input, maxBytes: raw.length - 1 })).rejects.toMatchObject({ code: 'file_too_large' });
  expect((await bind({ ...input, maxBytes: raw.length })).rawBytes).toEqual(raw);
  await writeFile(join(root, 'notes/original.md'), Buffer.from([0xff, 0xfe]));
  await expect(bind(input)).rejects.toMatchObject({ code: 'invalid_utf8' });
});

test('physical root identity and brain/source identity survive retarget detection', async () => {
  const { root, input } = await fixture();
  const original = await bind(input);
  expect(original.rootStat.ino).toBe((await stat(root, { bigint: true })).ino);
  expect((await bind({ ...input, brainId: 'brain-b' })).bindingKey).not.toBe(original.bindingKey);
  await rename(join(root, 'notes'), join(root, 'old-notes'));
  await mkdir(join(root, 'notes'));
  await writeFile(join(root, 'notes/original.md'), 'replacement');
  const replacement = await bind(input);
  expect(replacement.fileStat.ino).not.toBe(original.fileStat.ino);
  expect(replacement.rawSha256).not.toBe(original.rawSha256);
  const second = await fixture();
  expect((await bind({ ...input, sources: second.input.sources })).bindingKey).not.toBe(original.bindingKey);
});

test('rejects root traversal before normalization can erase symlink ancestors', async () => {
  const { root, input } = await fixture();
  input.sources = [{ id: 'wiki', local_path: root + '/notes/..' }];
  await expect(bind(input)).rejects.toMatchObject({ code: 'invalid_binding' });
});

test('default legacy source cannot bind inside another legacy source partition', async () => {
  const { root, input } = await fixture();
  await mkdir(join(root, '.sources/wiki'), { recursive: true });
  await writeFile(join(root, '.sources/wiki/note.md'), 'private');
  input.sourceId = 'default'; input.globalRepoPath = root;
  input.sources = [{ id: 'default', local_path: null }, { id: 'wiki', local_path: null }];
  input.sourcePath = '.sources/wiki/note.md';
  await expect(bind(input)).rejects.toMatchObject({ code: 'path_collision' });
});

async function bind(input: PageFileBindingInput) {
  const mod = await import('../src/core/page-file-binding.ts').catch(() => null);
  expect(mod?.resolveExistingPageFileBinding).toBeFunction();
  return mod!.resolveExistingPageFileBinding(input);
}

test('binds exact source-local original bytes without rewriting', async () => {
  const { root, raw, input } = await fixture();
  input.globalRepoPath = join(root, 'unused-missing-global');
  const before = await stat(join(root, 'notes/original.md'));
  const result = await bind(input);
  expect(result.canonicalRoot).toBe(root);
  expect(result.relativePath).toBe('notes/original.md');
  expect(result.absolutePath).toBe(join(root, 'notes/original.md'));
  expect(result.rawBytes).toEqual(raw);
  expect(result.rawSha256).toBe(createHash('sha256').update(raw).digest('hex'));
  expect(result.pageId).toBe('page-1');
  expect(result.brainId).toBe('brain-a');
  expect(result.sourceId).toBe('wiki');
  expect(result.configGeneration).toBe('config-1');
  expect(result.fileStat.ino).toBe(BigInt(before.ino));
  expect(await readFile(result.absolutePath)).toEqual(raw);
  expect((await stat(result.absolutePath)).mtimeMs).toBe(before.mtimeMs);
});
