import { createHash } from 'node:crypto';
import { constants, openSync, closeSync, fstatSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, normalize } from 'node:path';
import { z } from 'zod';
import type { BrainEngine } from './engine.ts';
import { validatePageFileHostManifest } from './page-file-host.ts';

const text = z.string().min(1).max(4096);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const anchorSchema = z.strictObject({ mode: z.literal('offline-verification'), bootstrapPath: text, bootstrapSha256: digest });
const contractSchema = z.strictObject({
  version: z.literal(1), manifestPath: text, credentialPath: text, credentialSha256: digest, ordinaryRole: text,
  sqlAuthority: z.strictObject({ roles: z.strictObject({ ordinary: text, adapter: text, enrollment: text }), catalogPins: z.record(z.string(), digest) }),
  expected: z.strictObject({ manifestSha256: digest, deploymentId: text, brainId: z.uuid(), database: text, adapterRole: text, generation: text }),
});
/** Serializable, secret-free provisioning record. No inline manifest or credentials.
 * Store as a private read-only file. The anchor digest MUST be supplied independently
 * by protected deployment startup, never derived from this file during startup.
 */
export type PageFileBootstrapContract = z.infer<typeof contractSchema>;
export type PageFileBootstrapAnchor = z.infer<typeof anchorSchema>;
const invalid = () => new Error('page_file_bootstrap_invalid');

/** Fixed deployment-owned file, never selected through request/job/DB config.
 * No production-mode anchor is accepted. Absence is disabled, malformed is fatal. */
export function loadPageFileStartupBootstrap() {
  const path = '/etc/gbrain/page-file-bootstrap-anchor.json';
  try { lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return loadPageFileBootstrap();
    throw invalid();
  }
  try {
    const pinned = readProtected(path);
    const loader = loadPageFileBootstrap(JSON.parse(pinned.bytes.toString('utf8')), () => {
      if (readProtected(path).fingerprint !== pinned.fingerprint) throw invalid();
    });
    return Object.freeze({ ...loader, async start(engine: BrainEngine) {
      if (readProtected(path).fingerprint !== pinned.fingerprint) throw invalid();
      return loader.start(engine);
    } });
  } catch { throw invalid(); }
}
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function identity(s: import('node:fs').BigIntStats) {
  return [s.dev, s.ino, s.uid, s.gid, s.mode, s.nlink, s.size, s.mtimeNs, s.ctimeNs].join(':');
}
/** Read one bounded regular file through O_NOFOLLOW and compare descriptor/path
 * identity before and after reading. Protected ancestors exclude other-UID races;
 * malicious code running as the service UID is outside the in-process model.
 */
function readProtected(path: string, secret = false) {
  if (!isAbsolute(path) || normalize(path) !== path || realpathSync(path) !== path) throw invalid();
  const uid = process.getuid?.();
  if (uid === undefined) throw invalid();
  const ancestors: string[] = [];
  for (let p = dirname(path); ; p = dirname(p)) {
    const s = lstatSync(p, { bigint: true });
    if (!s.isDirectory() || s.isSymbolicLink() || (s.mode & 0o022n) !== 0n || (s.uid !== 0n && s.uid !== BigInt(uid))) throw invalid();
    ancestors.push([p, s.dev, s.ino, s.uid, s.gid, s.mode].join(':'));
    if (p === dirname(p)) break;
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const s = fstatSync(fd, { bigint: true });
    const mode = s.mode & 0o7777n;
    if (!s.isFile() || s.uid !== BigInt(uid) || s.nlink !== 1n || (mode !== 0o400n && !(secret && mode === 0o600n)) || s.size > BigInt(secret ? 16384 : 1048576)) throw invalid();
    const bytes = readFileSync(fd);
    const key = identity(s);
    if (key !== identity(fstatSync(fd, { bigint: true })) || key !== identity(lstatSync(path, { bigint: true }))) throw invalid();
    return { bytes, fingerprint: [key, ...ancestors, sha(bytes)].join('|') };
  } finally { closeSync(fd); }
}

/** Internal lifecycle constructor: call once per ordinary-engine lifecycle, before
 * serving requests. No env, DB config, OperationContext or job payload is consulted.
 * This is OFFLINE ONLY; it does not remove any production admission guard.
 * Actual startup must supply the external anchor and await close before disconnect.
 */
export function loadPageFileBootstrap(input?: PageFileBootstrapAnchor, revalidateAnchor?: () => void) {
  if (input === undefined) return Object.freeze({ status: 'disabled' as const, async start(_engine: BrainEngine) { return undefined; } });
  try {
    const anchor = Object.freeze(anchorSchema.parse(input));
    const bootstrap = readProtected(anchor.bootstrapPath);
    if (sha(bootstrap.bytes) !== anchor.bootstrapSha256) throw invalid();
    const parsed = contractSchema.parse(JSON.parse(bootstrap.bytes.toString('utf8')));
    Object.freeze(parsed.sqlAuthority.roles); Object.freeze(parsed.sqlAuthority.catalogPins); Object.freeze(parsed.sqlAuthority);
    const contract = Object.freeze({ ...parsed, expected: Object.freeze(parsed.expected) });
    if (contract.sqlAuthority.roles.ordinary !== contract.ordinaryRole || contract.sqlAuthority.roles.adapter !== contract.expected.adapterRole
      || new Set(Object.values(contract.sqlAuthority.roles)).size !== 3) throw invalid();
    if (contract.ordinaryRole === contract.expected.adapterRole) throw invalid();
    const manifest = readProtected(contract.manifestPath);
    const hostOptions = Object.freeze({ mode: 'offline-verification' as const, manifestJson: manifest.bytes.toString('utf8'), expected: contract.expected });
    const host = validatePageFileHostManifest(hostOptions);
    if (host.manifest.serviceUid !== process.getuid?.()) throw invalid();
    const indexed = [...host.manifest.indexedRoots, ...host.manifest.roots.map(root => root.directory)];
    for (const path of [anchor.bootstrapPath, contract.manifestPath, contract.credentialPath]) {
      if (indexed.some(root => path === root.path || path.startsWith(root.path === '/' ? '/' : root.path + '/'))) throw invalid();
    }
    // Keep only a fingerprint, not credential bytes, in the captured descriptor.
    const credential = readProtected(contract.credentialPath, true);
    if (sha(credential.bytes) !== contract.credentialSha256) throw invalid();
    const credentialFingerprint = credential.fingerprint;
    credential.bytes.fill(0);
    const revalidate = () => {
      try {
        revalidateAnchor?.();
        if (readProtected(anchor.bootstrapPath).fingerprint !== bootstrap.fingerprint
          || readProtected(contract.manifestPath).fingerprint !== manifest.fingerprint
          || readProtected(contract.credentialPath, true).fingerprint !== credentialFingerprint) throw invalid();
        host.revalidate();
      } catch { throw invalid(); }
    };
    return Object.freeze({ status: 'offline-verification' as const, contract, revalidate,
      async start(engine: BrainEngine) {
        revalidate();
        try {
          const { createPageFileRuntimeCandidate } = await import('./page-file-runtime.ts');
          revalidate();
          const lifecycle = await createPageFileRuntimeCandidate({ mode: 'offline-verification', engine, host: hostOptions,
            authority: { mode: 'offline-verification', credentialReference: contract.credentialPath,
              async revalidate() { revalidate(); },
              sqlAuthority: { ...contract.sqlAuthority, database: contract.expected.database, role: contract.expected.adapterRole },
              expected: { role: contract.expected.adapterRole, database: contract.expected.database, ordinaryRole: contract.ordinaryRole },
              async resolveCredential(reference) {
                try {
                  if (reference !== contract.credentialPath) throw invalid();
                  revalidate();
                  const file = readProtected(reference, true);
                  if (file.fingerprint !== credentialFingerprint) throw invalid();
                  const value = file.bytes.toString('utf8').trim();
                  if (!value || !/^postgres(?:ql)?:\/\//.test(value)) throw invalid();
                  return value;
                } catch { throw invalid(); }
              },
            },
          });
          try { revalidate(); } catch { await lifecycle.close(); throw invalid(); }
          let closing: Promise<void> | undefined;
          return Object.freeze({ async revalidate() { revalidate(); await lifecycle.revalidate(); }, close(): Promise<void> {
            // Preserve rejected shutdown state too: no retry/fallback or secret cause.
            return closing ??= lifecycle.close().catch(() => { throw new Error('page_file_bootstrap_shutdown_failed'); });
          } });
        } catch { throw new Error('page_file_bootstrap_start_failed'); }
      },
    });
  } catch { throw invalid(); }
}
