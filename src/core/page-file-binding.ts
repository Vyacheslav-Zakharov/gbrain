import { lstat, realpath, open } from 'node:fs/promises';
import { constants, type BigIntStats } from 'node:fs';
import { resolve, isAbsolute, parse, sep } from 'node:path';
import { isValidSourceId } from './source-id.ts';
import { createHash } from 'node:crypto';

/** Versioned per-source mapping identity. The full inventory remains an input to
 * collision validation, never to this digest. Generation 1 is the explicit
 * disposable-adapter default; protected runtime hosts supply their pinned value.
 * This deliberately changes legacy keys: persisted bindings are never rebound. */
export function pageFileMappingIdentity(input: {
  sourceId: string; sources: readonly { id: string; local_path: string | null }[];
  globalRepoPath: string | null; mappingGeneration?: string;
}): string {
  const matches = input.sources.filter(source => source.id === input.sourceId);
  if (matches.length !== 1 || input.mappingGeneration === '') throw new PageFileBindingError('invalid_binding');
  const source = matches[0]!;
  return 'source-mapping-v1:' + createHash('sha256').update(JSON.stringify([
    input.sourceId, source.local_path, source.local_path === null ? input.globalRepoPath : null,
    input.mappingGeneration ?? '1',
  ])).digest('hex');
}

/** Server-owned metadata only. Never populate paths from remote request fields. */
export interface PageFileBindingInput {
  brainId: string;
  sourceId: string;
  slug: string;
  pageId: string;
  sourcePath: string | null;
  sources: readonly { id: string; local_path: string | null }[];
  /** Complete server-owned mapping inventory under the source/config gate. */
  otherPagePaths: readonly { pageId: string; sourceId: string; sourcePath: string }[];
  globalRepoPath: string | null;
  configGeneration: string;
  /** May lower, but not raise, the 8 MiB hard limit. */
  maxBytes?: number;
}
export interface ExistingPageFileBinding {
  brainId: string;
  sourceId: string;
  slug: string;
  pageId: string;
  configGeneration: string;
  canonicalRoot: string;
  relativePath: string;
  absolutePath: string;
  rawBytes: Buffer;
  rawSha256: string;
  fileStat: BigIntStats;
  rootStat: BigIntStats;
  /** Identity key, not a freshness token or persistent binding id. */
  bindingKey: string;
}
export class PageFileBindingError extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'PageFileBindingError'; }
}
function refuse(code: string): never { throw new PageFileBindingError(code); }
function validRelative(path: string): boolean {
  return !!path && !isAbsolute(path) && !/[\\\u0000:]/.test(path)
    && path.split('/').every(p => p !== '' && p !== '.' && p !== '..');
}
async function inspectPath(path: string, directory: boolean): Promise<BigIntStats> {
  const base = parse(path).root;
  let current = base;
  const parts = path.slice(base.length).split(sep).filter(Boolean);
  let result = await lstat(base, { bigint: true });
  for (let i = 0; i < parts.length; i++) {
    current = resolve(current, parts[i]!);
    try { result = await lstat(current, { bigint: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') refuse('missing_file');
      refuse('unsafe_file');
    }
    if (result.isSymbolicLink()) refuse('unsafe_file');
    if (i < parts.length - 1 || directory) {
      if (!result.isDirectory()) refuse('unsafe_file');
    } else if (!result.isFile() || result.nlink !== 1n) refuse('unsafe_file');
  }
  if (await realpath(path) !== path) refuse('unsafe_file');
  return result;
}

/** Read-only observation, NOT a race-safe open against hostile ancestor swaps.
 * Caller must hold cooperating root/path gates and revalidate before mutation.
 * O_NOFOLLOW only protects the final component; external writers remain outside
 * those gates. No hash/stat observation proves absence of external ABA writes.
 */
export async function resolveExistingPageFileBinding(input: PageFileBindingInput): Promise<ExistingPageFileBinding> {
  if (!isValidSourceId(input.sourceId) || !input.brainId || !input.pageId || !input.configGeneration
    || !validRelative(input.slug)) refuse('invalid_binding');
  const matches = input.sources.filter(s => s.id === input.sourceId);
  if (matches.length !== 1) refuse('invalid_binding');
  const source = matches[0]!;
  const root = source.local_path ?? input.globalRepoPath;
  if (!root || !isAbsolute(root) || root.includes('\u0000') || root.split(sep).some(p => p === '..' || p === '.')) refuse('invalid_binding');
  const canonicalRoot = resolve(source.local_path ?? (input.sourceId === 'default'
    ? input.globalRepoPath! : resolve(input.globalRepoPath!, '.sources', input.sourceId)));
  const relativePath = input.sourcePath ?? `${input.slug}.md`;
  if (!validRelative(relativePath) || !relativePath.endsWith('.md')) refuse('invalid_binding');
  const absolutePath = resolve(canonicalRoot, relativePath);
  const within = (parent: string, child: string) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
  for (const other of input.sources) {
    if (!isValidSourceId(other.id)) refuse('invalid_binding');
    if (other.id === input.sourceId) continue;
    if (!other.local_path) {
      // The default legacy root is a container, not ownership of .sources/*.
      if (input.globalRepoPath && other.id !== 'default'
        && within(resolve(input.globalRepoPath, '.sources', other.id), absolutePath)) refuse('path_collision');
      continue;
    }
    if (!isAbsolute(other.local_path)) refuse('invalid_binding');
    let otherRoot = resolve(other.local_path);
    try { otherRoot = await realpath(otherRoot); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') refuse('unsafe_file');
    }
    if (within(otherRoot, absolutePath) || (!source.local_path && within(otherRoot, resolve(root)))) refuse('path_collision');
  }
  if (!Array.isArray(input.otherPagePaths)) refuse('invalid_binding');
  for (const other of input.otherPagePaths) {
    if (!validRelative(other.sourcePath)) refuse('invalid_binding');
    if (other.sourceId === input.sourceId && other.pageId !== input.pageId
      && other.sourcePath === relativePath) refuse('path_collision');
  }
  const maxBytes = input.maxBytes ?? 8 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 8 * 1024 * 1024) refuse('invalid_binding');
  const rootStat = await inspectPath(canonicalRoot, true);
  const fileStat = await inspectPath(absolutePath, false);
  const handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let rawBytes: Buffer;
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || opened.ino !== fileStat.ino || opened.dev !== fileStat.dev) refuse('unsafe_file');
    if (opened.size > BigInt(maxBytes)) refuse('file_too_large');
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maxBytes) refuse('file_too_large');
    rawBytes = Buffer.from(buffer.subarray(0, length));
    const after = await handle.stat({ bigint: true });
    const named = await inspectPath(absolutePath, false);
    const rootAfter = await inspectPath(canonicalRoot, true);
    const same = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino
      && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.nlink === b.nlink;
    if (!same(fileStat, opened) || !same(opened, after) || !same(after, named)
      || rootAfter.dev !== rootStat.dev || rootAfter.ino !== rootStat.ino
      || BigInt(length) !== after.size) refuse('file_changed');
    try { new TextDecoder('utf-8', { fatal: true }).decode(rawBytes); }
    catch { refuse('invalid_utf8'); }
  } finally { await handle.close(); }
  return { brainId: input.brainId, sourceId: input.sourceId, slug: input.slug,
    pageId: input.pageId, configGeneration: input.configGeneration,
    canonicalRoot, relativePath, absolutePath, rawBytes,
    rawSha256: createHash('sha256').update(rawBytes).digest('hex'),
    fileStat, rootStat,
    bindingKey: createHash('sha256').update(JSON.stringify([input.brainId, input.sourceId,
      input.pageId, input.slug, input.configGeneration, canonicalRoot, relativePath,
      rootStat.dev.toString(), rootStat.ino.toString()])).digest('hex') };
}
