import { exerciseCombinedTransaction } from './cas-combined-transaction.ts';
import { expect } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PostgresEngine } from '../../../src/core/postgres-engine.ts';
import { enrollPageFileRuntime, hasPageFileRuntimeCandidate, resolvePageFileRuntime } from '../../../src/core/page-file-runtime.ts';
import { parseMarkdown } from '../../../src/core/markdown.ts';
import type { PageFileBootstrapContract } from '../../../src/core/page-file-bootstrap.ts';

const anchorPath = '/etc/gbrain/page-file-bootstrap-anchor.json';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Hosted-only caller of the actual fixed-path connected bootstrap. No module
 * mocks, injected startup loader or direct candidate construction. Provisioning
 * reuses the SQL-authority suite's frozen catalog and least-privilege logins. */
export async function exerciseConnectedBootstrap(f: Parameters<typeof exerciseConnectedBootstrapFixture>[0]) {
  await exerciseConnectedBootstrapFixture(f);
}

export async function exerciseConnectedSourceBootstrap(f: Parameters<typeof exerciseConnectedBootstrapFixture>[0]) {
  // A fresh fixture after v1 cleanup: never widen a retained v1 capability.
  await exerciseConnectedBootstrapFixture({ ...f, mode: 'production-pilot' }, true);
}

async function exerciseConnectedBootstrapFixture(f: {
  admin: PostgresEngine; source: string;
  roles: { ordinary: string; adapter: string; enrollment: string };
  loginUrls: Map<string, string>; pins: Record<string, string>;
  mode?: 'production-pilot';
}, sourceWide = false) {
  if (process.env.REQUIRE_PAGE_FILE_CONNECTED_POSTGRES !== '1' || process.env.GITHUB_ACTIONS !== 'true'
    || process.env.PAGE_FILE_CAS_DISPOSABLE !== '1') throw new Error('connected bootstrap requires explicit disposable hosted acceptance');
  if (f.mode && process.env.REQUIRE_PAGE_FILE_PILOT_POSTGRES !== '1') throw new Error('pilot requires explicit hosted acceptance');
  // The workflow creates ONLY an empty private fixture directory. Never replace
  // an existing deployment anchor. Pilot approval below authorizes this fixture only.
  expect(existsSync(anchorPath)).toBe(false);
  const directory = mkdtempSync('/etc/gbrain/connected-fixture-');
  const engines: PostgresEngine[] = [];
  let ownsAnchor = false;
  let primaryFailure: { error: unknown } | undefined;
  let phase = 'bootstrap-and-operator';
  const protectedFile = (name: string, value: string) => {
    const path = join(directory, name); writeFileSync(path, value, { flag: 'wx', mode: 0o400 }); return path;
  };
  const pin = (name: string) => {
    const path = join(directory, name); mkdirSync(path, { mode: 0o700 });
    const s = lstatSync(path, { bigint: true });
    return { path, dev: String(s.dev), ino: String(s.ino), uid: Number(s.uid), gid: Number(s.gid), mode: 0o700 as const };
  };
  const manifest = { version: 1, deploymentId: 'disposable-connected-fixture', brainId: randomUUID(),
    database: 'gbrain_test', adapterRole: f.roles.adapter, generation: '1', topology: 'single-host-local',
    serviceUid: process.getuid!(), roots: [{ sourceId: f.source, mappingGeneration: '1', directory: pin('root'), journal: pin('journal') }],
    lock: pin('lock'), indexedRoots: [] };
  const manifestJson = JSON.stringify(manifest), root = manifest.roots[0].directory.path;
  const credential = f.loginUrls.get(f.roles.adapter)!;
  const contract: PageFileBootstrapContract = { version: 1, ordinaryRole: f.roles.ordinary,
    manifestPath: protectedFile('manifest.json', manifestJson), credentialPath: protectedFile('adapter.credential', credential),
    credentialSha256: hash(credential), sqlAuthority: { roles: f.roles, catalogPins: f.pins },
    expected: { manifestSha256: hash(manifestJson), deploymentId: manifest.deploymentId, brainId: manifest.brainId,
      database: manifest.database, adapterRole: manifest.adapterRole, generation: '1' } };
  const bootstrap = JSON.stringify(contract);
  const bootstrapPath = protectedFile('bootstrap.json', bootstrap);
  const approval = JSON.stringify(sourceWide
    ? { version: 2, mode: 'production-pilot', bootstrapSha256: hash(bootstrap), sources: [f.source] }
    : { version: 1, mode: 'production-pilot', bootstrapSha256: hash(bootstrap), source: f.source, slug: 'connected' });
  const approvalPath = f.mode ? protectedFile('pilot-approval.json', approval) : undefined;
  const anchor = JSON.stringify(f.mode
    ? { mode: f.mode, bootstrapPath, bootstrapSha256: hash(bootstrap), approvalPath, approvalSha256: hash(approval) }
    : { mode: 'offline-verification', bootstrapPath, bootstrapSha256: hash(bootstrap) });
  const config = { database_url: f.loginUrls.get(f.roles.ordinary)!, poolSize: 1 };
  const engine = new PostgresEngine(); engines.push(engine);
  const ctx = { engine, config: { engine: 'postgres' as const }, remote: false as const };
  const sessions = () => f.admin.executeRaw('SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND usename=$1 ORDER BY pid', [f.roles.adapter]);
  const snapshot = async () => {
    const state: unknown[] = [];
    for (const table of ['pages', 'page_file_bindings']) state.push(await f.admin.executeRaw(`SELECT to_jsonb(t)::text AS row FROM ${table} t WHERE source_id=$1 ORDER BY to_jsonb(t)::text`, [f.source]));
    state.push(await f.admin.executeRaw('SELECT to_jsonb(c)::text AS row FROM config c ORDER BY key'));
    return state;
  };
  try {
    // Provision raw page before the anchor exists; enrollment is NOT performed
    // by connect/initSchema or normal request admission.
    const raw = '---\ntitle: Connected\ntype: note\n---\n\nBefore\n';
    writeFileSync(join(root, 'connected.md'), raw, { mode: 0o600 });
    const parsed = parseMarkdown(raw, 'connected.md');
    await f.admin.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [f.source, root]);
    await f.admin.executeRaw(`INSERT INTO pages(source_id,slug,type,title,compiled_truth,timeline,frontmatter,source_path)
      VALUES($1,'connected',$2,$3,$4,$5,$6::text::jsonb,'connected.md')`,
    [f.source, parsed.type, parsed.title, parsed.compiled_truth, parsed.timeline, JSON.stringify(parsed.frontmatter)]);
    writeFileSync(anchorPath, anchor, { flag: 'wx', mode: 0o400 }); ownsAnchor = true;
    await engine.connect(config);
    expect(await hasPageFileRuntimeCandidate(engine)).toBe(true);
    const [identity] = await engine.executeRaw('SELECT session_user,current_user,pg_backend_pid() AS pid');
    expect(identity.session_user).toBe(f.roles.ordinary); expect(identity.current_user).toBe(f.roles.ordinary);
    const adapter = await sessions(); expect(adapter.length).toBeGreaterThan(0);
    expect(adapter.every(row => row.pid !== identity.pid)).toBe(true);
    expect(await resolvePageFileRuntime(ctx, f.source, 'connected')).toBeUndefined();
    expect(await f.admin.executeRaw('SELECT binding_id FROM page_file_bindings WHERE source_id=$1', [f.source])).toEqual([]);
    const pristine = await snapshot(); await engine.initSchema(); expect(await snapshot()).toEqual(pristine);
    await engine.executeRaw("INSERT INTO pages(source_id,slug,type,title,compiled_truth) VALUES($1,'legacy-connected','note','Legacy','Before')", [f.source]);
    await engine.executeRaw("UPDATE pages SET compiled_truth='After' WHERE source_id=$1 AND slug='legacy-connected'", [f.source]);
    expect((await engine.executeRaw("SELECT compiled_truth FROM pages WHERE source_id=$1 AND slug='legacy-connected'", [f.source]))[0].compiled_truth).toBe('After');
    await engine.executeRaw("DELETE FROM pages WHERE source_id=$1 AND slug='legacy-connected'", [f.source]);
    expect(await snapshot()).toEqual(pristine);
    await exerciseCombinedTransaction(engine, f.admin, f.roles.ordinary);
    if (!f.mode) console.log('PG_CONNECTED_BOOTSTRAP: actual ordinary and adapter admission; initSchema no migration or enrollment');

    if (sourceWide) {
      phase = 'production-source-v2';
      const { exerciseConnectedSource } = await import('./page-file-connected-source.ts');
      await exerciseConnectedSource({ admin: f.admin, engine, source: f.source, root, directory,
        journal: manifest.roots[0].journal.path, bootstrap: JSON.parse(anchor),
        ordinaryUrl: config.database_url, enrollmentUrl: f.loginUrls.get(f.roles.enrollment)!,
        enrollmentRole: f.roles.enrollment });
      return;
    }
    const [page] = await engine.executeRaw<{ id: string; write_revision: string }>('SELECT id::text,write_revision FROM pages WHERE source_id=$1', [f.source]);
    await expect(enrollPageFileRuntime(ctx, f.source, 'connected')).rejects.toThrow('page_file_candidate_lifecycle_unavailable');
    const { exerciseConnectedOperator } = await import('./page-file-connected-operator.ts');
    await exerciseConnectedOperator({ admin: f.admin, engine, source: f.source, root, directory,
      bootstrap: JSON.parse(anchor), ordinaryUrl: config.database_url,
      enrollmentUrl: f.loginUrls.get(f.roles.enrollment)!,
      reviewed: { hostManifestSha256: hash(manifestJson), source: f.source, slug: 'connected', pageId: page.id,
        revision: page.write_revision, canonicalRoot: root, relativePath: 'connected.md', rawSha256: hash(raw) },
    });
    let runtime = (await resolvePageFileRuntime(ctx, f.source, 'connected'))!;
    expect((await runtime.pages.get(f.source, 'connected', () => {})).persistence).toBe('file_and_database');
    if (f.mode) {
      phase = 'production-pilot';
      const { exerciseConnectedPilot } = await import('./page-file-connected-pilot.ts');
      await exerciseConnectedPilot({ admin: f.admin, engine, source: f.source, root,
        journal: manifest.roots[0].journal.path, approvalPath: approvalPath!, lock: manifest.lock.path,
        enrollmentUrl: f.loginUrls.get(f.roles.enrollment)!, enrollmentRole: f.roles.enrollment,
        ordinaryUrl: config.database_url, ordinaryRole: f.roles.ordinary });
      return; // Separate fixture invocation: offline crash/upgrade proofs stay unchanged.
    }
    const stable = await snapshot();
    await engine.disconnect();
    // SQL suite's own adapter probe pool is still open; only startup's additional
    // private session must disappear, not the independently-owned fixture pool.
    expect((await sessions()).length).toBeLessThan(adapter.length);
    // Candidate target checks may throw synchronously before returning a promise.
    // Normalize invocation, not just its result, so both failure forms are asserted.
    await expect(Promise.resolve().then(() => runtime.pages.get(f.source, 'connected', () => {}))).rejects.toThrow('page_file_runtime_closed');
    await engine.connect(config); await engine.initSchema();
    runtime = (await resolvePageFileRuntime(ctx, f.source, 'connected'))!;
    expect((await runtime.pages.get(f.source, 'connected', () => {})).persistence).toBe('file_and_database');
    await engine.reconnect();
    runtime = (await resolvePageFileRuntime(ctx, f.source, 'connected'))!;
    expect((await runtime.pages.get(f.source, 'connected', () => {})).persistence).toBe('file_and_database');
    await expect(engine.executeRaw("UPDATE pages SET compiled_truth='Forbidden' WHERE source_id=$1", [f.source])).rejects.toMatchObject({ code: 'P0001' });
    expect(await snapshot()).toEqual(stable);
    console.log('PG_CONNECTED_BOOTSTRAP: operator-only enrollment; disconnect tombstone and same-engine reconnect');

    // Capture the service BEFORE mutation: these calls prove per-borrow checks,
    // not merely fresh routing checks. Never refresh catalog pins on drift.
    for (const role of [f.roles.ordinary, f.roles.adapter]) {
      await f.admin.executeRaw(`GRANT INSERT ON page_file_bindings TO ${role}`);
      try {
        await expect(Promise.resolve().then(() => runtime.pages.get(f.source, 'connected', () => {}))).rejects.toThrow();
        expect(await snapshot()).toEqual(stable); expect(readFileSync(join(root, 'connected.md'), 'utf8')).toBe(raw);
      } finally { await f.admin.executeRaw(`REVOKE INSERT ON page_file_bindings FROM ${role}`); }
      expect((await runtime.pages.get(f.source, 'connected', () => {})).persistence).toBe('file_and_database');
    }
    await f.admin.executeRaw('ALTER TABLE pages DISABLE TRIGGER aa_file_page_write_fence');
    try {
      await expect(engine.initSchema()).rejects.toThrow();
      expect((await f.admin.executeRaw("SELECT tgenabled FROM pg_trigger WHERE tgrelid='public.pages'::regclass AND tgname='aa_file_page_write_fence'"))[0].tgenabled).toBe('D');
      expect(await snapshot()).toEqual(stable);
    } finally { await f.admin.executeRaw('ALTER TABLE pages ENABLE TRIGGER aa_file_page_write_fence'); }
    await engine.initSchema();
    console.log('PG_CONNECTED_BOOTSTRAP: per-borrow ordinary and adapter drift denied; no catalog self-repair');
    chmodSync(anchorPath, 0o600);
    await expect(Promise.resolve().then(() => runtime.pages.get(f.source, 'connected', () => {}))).rejects.toThrow();
    await expect(engine.initSchema()).rejects.toThrow();
    await expect(engine.reconnect()).rejects.toThrow();
    expect(await snapshot()).toEqual(stable); expect(readFileSync(join(root, 'connected.md'), 'utf8')).toBe(raw);
    console.log('PG_CONNECTED_BOOTSTRAP: protected fixed anchor drift denied without mutation');
    // Narrow combined lane excludes unrelated crash and dirty-root matrices.
  } catch (error) {
    primaryFailure = { error };
    // Phase labels are fixed fixture vocabulary, never URLs, requests or credentials.
    console.error(`PG_CONNECTED_FAILURE: phase=${phase}`);
    throw error;
  } finally {
    let cleanupFailure: { error: unknown } | undefined;
    // Attempt every resource cleanup, but preserve the original assertion/error.
    // These owner-only deletes are scoped to this disposable fixture source.
    const steps = [
      ...engines.map(e => () => e.disconnect()),
      () => { if (ownsAnchor) rmSync(anchorPath); },
      async () => {
        await f.admin.executeRaw('DELETE FROM page_file_write_authorizations WHERE page_id IN (SELECT id FROM pages WHERE source_id=$1)', [f.source]);
        await f.admin.executeRaw('DELETE FROM page_file_operations WHERE binding_id IN (SELECT binding_id FROM page_file_bindings WHERE source_id=$1)', [f.source]);
        await f.admin.executeRaw('DELETE FROM page_file_bindings WHERE source_id=$1', [f.source]);
        await f.admin.executeRaw('DELETE FROM sources WHERE id=$1', [f.source]);
      },
      () => rmSync(directory, { recursive: true, force: true }),
    ];
    for (const step of steps) {
      try { await step(); } catch (error) { cleanupFailure ??= { error }; }
    }
    if (cleanupFailure) {
      if (primaryFailure) console.error('PG_CONNECTED_CLEANUP_FAILURE: original test error preserved');
      else throw cleanupFailure.error;
    }
  }
}
