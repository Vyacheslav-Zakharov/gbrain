import { createHash, randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { vector } from '@electric-sql/pglite/vector';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

// Bun only embeds non-code package assets when they are explicit `type: file`
// imports. These paths are valid both in a source checkout and in a globally
// installed package (`src/core` and `node_modules` share the package root).
// @ts-ignore — type: file is Bun ESM syntax.
import fsBundlePath from '../../node_modules/@electric-sql/pglite/dist/pglite.data' with { type: 'file' };
// @ts-ignore — type: file is Bun ESM syntax.
import pgliteWasmPath from '../../node_modules/@electric-sql/pglite/dist/pglite.wasm' with { type: 'file' };
// @ts-ignore — type: file is Bun ESM syntax.
import initdbWasmPath from '../../node_modules/@electric-sql/pglite/dist/initdb.wasm' with { type: 'file' };
// @ts-ignore — type: file is Bun ESM syntax.
import vectorBundlePath from '../../node_modules/@electric-sql/pglite/dist/vector.tar.gz' with { type: 'file' };
// @ts-ignore — type: file is Bun ESM syntax.
import pgTrgmBundlePath from '../../node_modules/@electric-sql/pglite/dist/pg_trgm.tar.gz' with { type: 'file' };

interface EmbeddedPgliteRuntime {
  fsBundle: Blob;
  pgliteWasmModule: WebAssembly.Module;
  initdbWasmModule: WebAssembly.Module;
  extensions: {
    vector: typeof vector;
    pg_trgm: typeof pg_trgm;
  };
}

let runtimePromise: Promise<EmbeddedPgliteRuntime | null> | null = null;

function isBunEmbeddedPath(path: string): boolean {
  return path.startsWith('/$bunfs/');
}

async function privateAssetCacheDir(): Promise<string> {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const dir = join(tmpdir(), `gbrain-pglite-assets-${uid}`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const stat = await lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`unsafe PGLite asset cache path: ${dir}`);
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`PGLite asset cache is owned by another user: ${dir}`);
  }
  await chmod(dir, 0o700);
  return dir;
}

async function readEmbeddedAsset(path: string): Promise<Uint8Array> {
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  if (bytes.byteLength === 0) throw new Error(`embedded PGLite asset is empty: ${basename(path)}`);
  return bytes;
}

/** PGlite's Node extension loader requires a real fs path, not Bun's VFS. */
async function materializeExtensionBundle(path: string, label: string): Promise<string> {
  const bytes = await readEmbeddedAsset(path);
  const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  const dir = await privateAssetCacheDir();
  const target = join(dir, `${label}-${digest}.tar.gz`);
  try {
    const stat = await lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== (process.getuid?.() ?? stat.uid)) {
      throw new Error(`unsafe materialized PGLite asset: ${target}`);
    }
    const existingDigest = createHash('sha256').update(await readFile(target)).digest('hex').slice(0, 16);
    if (existingDigest === digest) return target;
    await unlink(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const temporary = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
  try {
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  await chmod(target, 0o600);
  return target;
}

function extensionFromRealBundle<T extends { setup: (...args: any[]) => Promise<any> }>(
  extension: T,
  path: string,
): T {
  return {
    ...extension,
    setup: async (...args: Parameters<T['setup']>) => ({
      ...(await extension.setup(...args)),
      bundlePath: pathToFileURL(path),
    }),
  } as T;
}

async function loadCompiledRuntime(): Promise<EmbeddedPgliteRuntime | null> {
  if (!isBunEmbeddedPath(fsBundlePath)) return null;
  const [fsBytes, pgliteWasmBytes, initdbWasmBytes, vectorPath, trgmPath] = await Promise.all([
    readEmbeddedAsset(fsBundlePath),
    readEmbeddedAsset(pgliteWasmPath),
    readEmbeddedAsset(initdbWasmPath),
    materializeExtensionBundle(vectorBundlePath, 'vector'),
    materializeExtensionBundle(pgTrgmBundlePath, 'pg-trgm'),
  ]);
  const [pgliteWasmModule, initdbWasmModule] = await Promise.all([
    WebAssembly.compile(pgliteWasmBytes),
    WebAssembly.compile(initdbWasmBytes),
  ]);
  return {
    fsBundle: new Blob([
      fsBytes.buffer.slice(fsBytes.byteOffset, fsBytes.byteOffset + fsBytes.byteLength) as ArrayBuffer,
    ]),
    pgliteWasmModule,
    initdbWasmModule,
    extensions: {
      vector: extensionFromRealBundle(vector, vectorPath),
      pg_trgm: extensionFromRealBundle(pg_trgm, trgmPath),
    },
  };
}

/** Return overrides only inside a Bun compiled executable; source runs use package defaults. */
export function prepareEmbeddedPgliteRuntime(): Promise<EmbeddedPgliteRuntime | null> {
  if (!runtimePromise) {
    runtimePromise = loadCompiledRuntime().catch((error) => {
      runtimePromise = null;
      throw error;
    });
  }
  return runtimePromise;
}
