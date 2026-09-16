import { expect } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import postgres from 'postgres';
import { join } from 'node:path';
import type { PostgresEngine } from '../../../src/core/postgres-engine.ts';
import { operationsByName, type OperationContext } from '../../../src/core/operations.ts';
import { resolvePageFileRootHost, resolvePageFileRuntime } from '../../../src/core/page-file-runtime.ts';
import { snapshotCrashJournal } from './page-file-connected-crash.ts';

/** Real connected production-pilot code path, disposable hosted PostgreSQL only.
 * The caller installs a separately pinned approval for exactly source/connected.
 * No runtime mocks, direct candidate constructor, or owner enrollment shortcut. */
export async function exerciseConnectedPilot(f: {
  admin: PostgresEngine; engine: PostgresEngine; source: string; root: string;
  journal: string; approvalPath: string; lock: string;
  enrollmentUrl: string; enrollmentRole: string;
}) {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.PAGE_FILE_CAS_DISPOSABLE !== '1'
    || process.env.REQUIRE_PAGE_FILE_CONNECTED_POSTGRES !== '1'
    || process.env.REQUIRE_PAGE_FILE_PILOT_POSTGRES !== '1') throw new Error('pilot requires disposable hosted acceptance');
  const ctx = { engine: f.engine, config: { engine: 'postgres' }, remote: false,
    sourceId: f.source, dryRun: false, logger: { info() {}, warn() {}, error() {}, debug() {} } } as OperationContext;
  const invoke = (name: string, request: any) => operationsByName[name].handler(ctx, request) as Promise<any>;
  const get = () => invoke('get_page_checked', { source_id: f.source, slug: 'connected' });
  const state = async () => {
    const rows: unknown[] = [];
    for (const table of ['pages', 'page_file_bindings']) rows.push(await f.admin.executeRaw(
      `SELECT to_jsonb(t)::text AS row FROM ${table} t WHERE source_id=$1 ORDER BY to_jsonb(t)::text`, [f.source]));
    rows.push(await f.admin.executeRaw(`SELECT to_jsonb(t)::text AS row FROM page_file_operations t
      WHERE binding_id IN (SELECT binding_id FROM page_file_bindings WHERE source_id=$1) ORDER BY operation_id`, [f.source]));
    for (const table of ['page_versions', 'content_chunks', 'page_file_write_authorizations']) rows.push(await f.admin.executeRaw(
      `SELECT to_jsonb(t)::text AS row FROM ${table} t WHERE page_id IN (SELECT id FROM pages WHERE source_id=$1) ORDER BY to_jsonb(t)::text`, [f.source]));
    rows.push(await f.admin.executeRaw('SELECT to_jsonb(c)::text AS row FROM config c ORDER BY key'));
    return { rows, raw: readFileSync(join(f.root, 'connected.md')).toString('hex'), journal: snapshotCrashJournal(f.journal) };
  };
  const before = await get();
  expect(before.persistence).toBe('file_and_database');
  const raw = before.file.raw_markdown.replace(before.page.compiled_truth, 'Pilot checked write');
  const request = { source_id: f.source, slug: 'connected', operation_id: randomUUID(),
    expected_revision: before.revision, file_baseline: before.file.baseline,
    page: { ...before.page, compiled_truth: 'Pilot checked write' }, raw_markdown: raw };
  const written = await invoke('put_page_checked', request);
  expect(written.status).toBe('committed');
  expect(written.persistence).toBe('file_and_database');
  const after = await get();
  expect(after.revision).toBe(written.revision);
  expect(after.revision).not.toBe(before.revision);
  expect(after.page.compiled_truth).toBe('Pilot checked write');
  expect(after.file.raw_markdown).toBe(raw);
  expect(readFileSync(join(f.root, 'connected.md'), 'utf8')).toBe(raw);
  expect((await f.admin.executeRaw('SELECT state FROM page_file_operations WHERE operation_id=$1', [request.operation_id]))[0].state).toBe('committed');
  console.log('PG_CONNECTED_PILOT: actual checked write and read commit file database and receipt');

  // Actual private root service: approved-only success first, then a binding
  // enrolled after service resolution. No approval/pin or grant widening.
  const git = (...args: string[]) => execFileSync('git', ['-C', f.root, ...args], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' },
    encoding: 'utf8', timeout: 10_000, stdio: 'pipe',
  });
  git('init', '-b', 'main'); git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'pilot root fixture');
  const host = (await resolvePageFileRootHost(ctx, f.root))!;
  expect(host).toBeDefined();
  const marker = join(f.lock, createHash('sha256').update(f.root + '\0ROOT').digest('hex') + '.dirty');
  const generation = async () => (await f.admin.executeRaw<{ generation: string }>(
    "SELECT file_generation::text AS generation FROM page_file_bindings WHERE source_id=$1 AND slug='connected'", [f.source]))[0].generation;
  const initialGeneration = await generation();
  expect(existsSync(join(f.journal, request.operation_id, 'record.json'))).toBe(true);
  const originalRoot = snapshotCrashJournal(f.root), originalJournal = snapshotCrashJournal(f.journal);
  expect(await host.transition!(async () => 'approved-root')).toBe('approved-root');
  expect(BigInt(await generation())).toBe(BigInt(initialGeneration) + 1n);
  expect(existsSync(marker)).toBe(false);
  writeFileSync(marker, 'approved interrupted root', { mode: 0o600 });
  const beforeReconcile = await state();
  await host.reconcile!();
  expect(existsSync(marker)).toBe(false);
  expect(existsSync(marker + '.observed')).toBe(true);
  expect(await state()).toEqual(beforeReconcile);
  expect(snapshotCrashJournal(f.root)).toEqual(originalRoot);
  expect(snapshotCrashJournal(f.journal)).toEqual(originalJournal);
  console.log('PG_CONNECTED_PILOT: approved-only root transition and dirty reconciliation succeed');

  const excludedRaw = '---\ntitle: Excluded\ntype: note\n---\n\nExcluded cohort\n';
  writeFileSync(join(f.root, 'pilot-excluded.md'), excludedRaw, { mode: 0o600 });
  const [excluded] = await f.engine.executeRaw<{ id: string }>(
    "INSERT INTO pages(source_id,slug,type,title,compiled_truth,source_path) VALUES($1,'pilot-excluded','note','Excluded','Excluded cohort','pilot-excluded.md') RETURNING id::text", [f.source]);
  // Adversarial fixture provisioning through the existing separate enrollment
  // login, not the pilot operator (which correctly rejects this excluded page).
  const enrollment = postgres(f.enrollmentUrl, { max: 1, connect_timeout: 5 });
  try {
    const [identity] = await enrollment.unsafe('SELECT session_user,current_user');
    expect(identity.session_user).toBe(f.enrollmentRole);
    expect(identity.current_user).toBe(f.enrollmentRole);
    await enrollment.unsafe(`INSERT INTO page_file_bindings(source_id,slug,page_id,binding_key,canonical_root,relative_path,indexed_raw_sha256)
      VALUES($1,'pilot-excluded',$2,$3,$4,'pilot-excluded.md',$5)`,
    [f.source, excluded.id, randomUUID(), f.root, createHash('sha256').update(excludedRaw).digest('hex')]);
  } finally { await enrollment.end({ timeout: 5 }); }
  expect(await f.admin.executeRaw('SELECT slug,canonical_root FROM page_file_bindings WHERE source_id=$1 ORDER BY slug', [f.source])).toEqual([
    { slug: 'connected', canonical_root: f.root }, { slug: 'pilot-excluded', canonical_root: f.root },
  ]);
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'mixed cohort fixture');
  expect(git('status', '--porcelain', '--untracked-files=all')).toBe('');
  const rootState = async () => ({
    dbAndFile: await state(), rootAndGit: snapshotCrashJournal(f.root),
    markers: readdirSync(f.lock).filter(name => name.includes('.dirty')).sort()
      .map(name => [name, snapshotCrashJournal(join(f.lock, name))]),
    approval: snapshotCrashJournal(f.approvalPath),
  });
  for (const action of ['transition', 'reconcile'] as const) {
    if (action === 'reconcile') writeFileSync(marker, 'preserve excluded-cohort dirty evidence', { mode: 0o600 });
    const beforeRoot = await rootState();
    let mutated = false;
    await expect(Promise.resolve().then(() => action === 'transition'
      ? host.transition!(async () => { mutated = true; writeFileSync(join(f.root, 'connected.md'), 'forbidden'); })
      : host.reconcile!())).rejects.toThrow('page_file_pilot_target_unapproved');
    expect(mutated).toBe(false);
    expect(await rootState()).toEqual(beforeRoot);
  }
  console.log('PG_CONNECTED_PILOT: late mixed-cohort root transition and recovery refuse preserving DB files Git journal and markers');
  // The rejected recovery intentionally leaves the dirty marker intact. The
  // remainder exercises approval revocation, not dirty-root handling; remove
  // only our fixture marker after the preservation assertions above.
  renameSync(marker, marker + '.fixture-preserved');

  const stable = await state();
  await f.engine.executeRaw("INSERT INTO pages(source_id,slug,type,title,compiled_truth) VALUES($1,'pilot-ordinary','note','Ordinary','Before')", [f.source]);
  expect(await resolvePageFileRuntime(ctx, f.source, 'pilot-ordinary')).toBeUndefined();
  await f.engine.executeRaw("UPDATE pages SET compiled_truth='After' WHERE source_id=$1 AND slug='pilot-ordinary'", [f.source]);
  expect((await f.engine.executeRaw("SELECT compiled_truth FROM pages WHERE source_id=$1 AND slug='pilot-ordinary'", [f.source]))[0].compiled_truth).toBe('After');
  await f.engine.executeRaw("DELETE FROM pages WHERE source_id=$1 AND slug='pilot-ordinary'", [f.source]);
  await expect(f.engine.executeRaw("UPDATE pages SET compiled_truth='Forbidden' WHERE source_id=$1 AND slug='connected'", [f.source])).rejects.toMatchObject({ code: 'P0001' });
  expect(await state()).toEqual(stable);
  console.log('PG_CONNECTED_PILOT: ordinary unenrolled DML coexists and enrolled SQL fence remains');

  const retained = (await resolvePageFileRuntime(ctx, f.source, 'connected'))!;
  // Prove this exact retained service is healthy before revoking only approval.
  const retainedGet = () => retained.pages.get(f.source, 'connected', () => {});
  const retainedBefore = await retainedGet();
  expect(retainedBefore.persistence).toBe('file_and_database');
  expect(await state()).toEqual(stable);
  renameSync(f.approvalPath, f.approvalPath + '.revoked');
  try {
    await expect(get()).rejects.toThrow('page_file_bootstrap_invalid');
    await expect(invoke('put_page_checked', { ...request, operation_id: randomUUID(),
      expected_revision: after.revision, file_baseline: after.file.baseline })).rejects.toThrow('page_file_bootstrap_invalid');
    // The retained authority redacts bootstrap revalidation errors at run(),
    // unlike operation resolution above. Exact API error, not a loose refusal.
    await expect(retainedGet()).rejects.toMatchObject({ message: 'page_file_authority_unavailable' });
    expect(await state()).toEqual(stable);
    // A-B-A control: restore the SAME approval inode and prove the SAME service
    // works again. This rules out a dead pool/dirty root/unrelated generic error.
    renameSync(f.approvalPath + '.revoked', f.approvalPath);
    try {
      expect(await retainedGet()).toEqual(retainedBefore);
      expect(await state()).toEqual(stable);
    } finally { renameSync(f.approvalPath, f.approvalPath + '.revoked'); }
    await expect(f.engine.reconnect()).rejects.toThrow('page_file_bootstrap_invalid');
    expect(await state()).toEqual(stable);
    console.log('PG_CONNECTED_PILOT: revoked approval denies checked read write retained service and reconnect without mutation');
  } finally { renameSync(f.approvalPath + '.revoked', f.approvalPath); }
}
