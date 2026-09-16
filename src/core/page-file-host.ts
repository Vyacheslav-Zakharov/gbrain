import { createHash } from 'node:crypto';
import { z } from 'zod';
import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, normalize } from 'node:path';
function validateDirectory(pin: z.infer<typeof directory>, uid: number) {
  if (!isAbsolute(pin.path) || normalize(pin.path) !== pin.path || realpathSync(pin.path) !== pin.path) throw new Error('page_file_host_noncanonical_path');
  for (let path = pin.path; ; path = dirname(path)) {
    const s = lstatSync(path, { bigint: true });
    if (!s.isDirectory() || s.isSymbolicLink()) throw new Error('page_file_host_unsafe_directory');
    if ((s.mode & 0o022n) !== 0n || (s.uid !== 0n && s.uid !== BigInt(uid))) throw new Error('page_file_host_unsafe_ancestor');
    if (path === pin.path && (String(s.dev) !== pin.dev || String(s.ino) !== pin.ino || Number(s.uid) !== pin.uid || pin.uid !== uid || Number(s.gid) !== pin.gid || Number(s.mode & 0o7777n) !== pin.mode)) throw new Error('page_file_host_directory_drift');
    if (path === dirname(path)) break;
  }
}
const text = z.string().min(1).max(4096);
const directory = z.strictObject({ path: text, dev: z.string().regex(/^(0|[1-9][0-9]*)$/), ino: z.string().regex(/^[1-9][0-9]*$/), uid: z.number().int().nonnegative(), gid: z.number().int().nonnegative(), mode: z.literal(0o700) });
const schema = z.strictObject({ version: z.literal(1), deploymentId: text, brainId: z.uuid(), database: text, adapterRole: text, generation: text, topology: z.literal('single-host-local'), serviceUid: z.number().int().nonnegative(), roots: z.array(z.strictObject({ sourceId: text, mappingGeneration: text, directory, journal: directory })).min(1).max(1024), lock: directory, indexedRoots: z.array(directory).max(1024) });
export type PageFileHostManifest = z.infer<typeof schema>;
export interface PageFileHostManifestOptions {
  mode: 'offline-verification' | 'production-pilot';
  manifestJson: string;
  /** From an independently protected durable host/DB record, not the manifest itself. */
  expected: { manifestSha256: string; deploymentId: string; brainId: string; database: string; adapterRole: string; generation: string };
}
type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
function freeze<T>(value: T): DeepReadonly<T> {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value as DeepReadonly<T>;
}
/** Pure host validation; does not itself grant runtime or SQL authority. */
export function validatePageFileHostManifest(options: PageFileHostManifestOptions) {
  if (options.mode !== 'offline-verification' && options.mode !== 'production-pilot') throw new Error('file_runtime_prerequisites_pending');
  if (typeof options.manifestJson !== 'string' || Buffer.byteLength(options.manifestJson) > 1024 * 1024) throw new Error('page_file_host_manifest_invalid');
  const manifestSha256 = createHash('sha256').update(options.manifestJson).digest('hex');
  const manifest = schema.parse(JSON.parse(options.manifestJson));
  if (manifestSha256 !== options.expected.manifestSha256 || (['deploymentId', 'brainId', 'database', 'adapterRole', 'generation'] as const).some(k => manifest[k] !== options.expected[k])) throw new Error('page_file_host_identity_mismatch');
  for (const pin of [manifest.lock, ...manifest.indexedRoots, ...manifest.roots.flatMap(r => [r.directory, r.journal])]) validateDirectory(pin, manifest.serviceUid);
  const inside = (a: string, b: string) => a === b || a.startsWith(b === '/' ? '/' : b + '/');
  const roots = manifest.roots.map(r => r.directory);
  const inventory = [...roots, ...manifest.indexedRoots];
  if (new Set(manifest.roots.map(r => r.sourceId)).size !== roots.length) throw new Error('page_file_host_duplicate_source');
  for (let i = 0; i < inventory.length; i++) for (let j = i + 1; j < inventory.length; j++) {
    const a = inventory[i], b = inventory[j];
    if (inside(a.path, b.path) || inside(b.path, a.path) || (a.dev === b.dev && a.ino === b.ino)) throw new Error('page_file_host_root_collision');
  }
  for (const evidence of [manifest.lock, ...manifest.roots.map(r => r.journal)]) {
    if (inventory.some(root => inside(evidence.path, root.path))) throw new Error('page_file_host_evidence_inside_root');
  }
  for (const root of manifest.roots) if (root.journal.dev !== root.directory.dev) throw new Error('page_file_host_journal_device_mismatch');
  const pins = [manifest.lock, ...manifest.indexedRoots, ...manifest.roots.flatMap(r => [r.directory, r.journal])];
  const ancestors = new Map<string, string>();
  const identity = (path: string) => { const s = lstatSync(path, { bigint: true }); return [s.dev, s.ino, s.uid, s.gid, s.mode].join(':'); };
  for (const pin of pins) for (let path = dirname(pin.path); ; path = dirname(path)) {
    ancestors.set(path, identity(path));
    if (path === dirname(path)) break;
  }
  const revalidate = () => {
    for (const pin of pins) validateDirectory(pin, manifest.serviceUid);
    for (const [path, expected] of ancestors) if (identity(path) !== expected) throw new Error('page_file_host_ancestor_drift');
  };
  return Object.freeze({ manifest: freeze(manifest), manifestSha256, revalidate });
}
