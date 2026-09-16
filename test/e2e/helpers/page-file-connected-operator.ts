import { expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PostgresEngine } from '../../../src/core/postgres-engine.ts';
import { loadPageFileOperator, runPageFileOperator } from '../../../src/commands/page-file-operator.ts';

const anchorPath = '/etc/gbrain/page-file-operator-anchor.json';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Actual executable, same disposable SQL fixture and protected bootstrap.
 * Only enroll may open the separate credential. No SQL enrollment shortcut. */
export async function exerciseConnectedOperator(f: {
  admin: PostgresEngine; engine: PostgresEngine; source: string; root: string; directory: string;
  bootstrap: { mode: 'offline-verification'; bootstrapPath: string; bootstrapSha256: string };
  reviewed: { hostManifestSha256: string; source: string; slug: string; pageId: string;
    revision: string; canonicalRoot: string; relativePath: string; rawSha256: string };
  ordinaryUrl: string; enrollmentUrl: string;
}) {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.PAGE_FILE_CAS_DISPOSABLE !== '1'
    || process.env.REQUIRE_PAGE_FILE_CONNECTED_POSTGRES !== '1') throw new Error('operator requires disposable hosted fixture');
  expect(existsSync(anchorPath)).toBe(false);
  const secret = join(f.directory, 'operator-enrollment.credential');
  writeFileSync(secret, f.enrollmentUrl, { flag: 'wx', mode: 0o400 });
  const home = join(f.directory, 'operator-home'); mkdirSync(home, { mode: 0o700 });
  writeFileSync(join(home, 'config.json'), JSON.stringify({ engine: 'postgres', database_url: f.ordinaryUrl, poolSize: 1 }), { flag: 'wx', mode: 0o600 });
  let ownsAnchor = false, serial = 0;
  const install = (reviewed: typeof f.reviewed) => {
    const reviewedJson = JSON.stringify(reviewed), reviewedPath = join(f.directory, `operator-reviewed-${serial}.json`);
    writeFileSync(reviewedPath, reviewedJson, { flag: 'wx', mode: 0o400 });
    const contract = JSON.stringify({ version: 1, mode: 'offline-verification', bootstrap: f.bootstrap,
      enrollmentCredentialPath: secret, enrollmentCredentialSha256: hash(f.enrollmentUrl), reviewedPath, reviewedSha256: hash(reviewedJson) });
    const operatorPath = join(f.directory, `operator-contract-${serial++}.json`);
    writeFileSync(operatorPath, contract, { flag: 'wx', mode: 0o400 });
    if (ownsAnchor) { rmSync(anchorPath); ownsAnchor = false; }
    writeFileSync(anchorPath, JSON.stringify({ operatorPath, operatorSha256: hash(contract) }), { flag: 'wx', mode: 0o400 }); ownsAnchor = true;
  };
  const state = async () => {
    const rows: unknown[] = [];
    for (const table of ['pages', 'page_file_bindings']) rows.push(await f.admin.executeRaw(
      `SELECT to_jsonb(t)::text AS row FROM ${table} t WHERE source_id=$1 ORDER BY to_jsonb(t)::text`, [f.source]));
    rows.push(await f.admin.executeRaw(`SELECT to_jsonb(t)::text AS row FROM page_file_operations t
      WHERE binding_id IN (SELECT binding_id FROM page_file_bindings WHERE source_id=$1) ORDER BY operation_id`, [f.source]));
    for (const table of ['page_versions', 'content_chunks']) rows.push(await f.admin.executeRaw(
      `SELECT to_jsonb(t)::text AS row FROM ${table} t WHERE page_id IN (SELECT id FROM pages WHERE source_id=$1) ORDER BY to_jsonb(t)::text`, [f.source]));
    rows.push(await f.admin.executeRaw('SELECT to_jsonb(c)::text AS row FROM config c ORDER BY key'));
    return { rows, raw: readFileSync(join(f.root, 'connected.md'), 'utf8') };
  };
  const invoke = async (action: string, expected?: string) => {
    // Deliberately exclude inherited owner/adapter credentials and direct URL overrides.
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, '../../../src/commands/page-file-operator.ts'), action], {
      cwd: home, env: { PATH: process.env.PATH, HOME: home, GBRAIN_HOME: home, GBRAIN_DATABASE_URL: f.ordinaryUrl },
      stdout: 'pipe', stderr: 'pipe',
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('operator deadline 15s')), 15_000); }),
      ]);
      expect(result[0]).toBe(expected ? 0 : 1);
      if (expected) expect(JSON.parse(result[1])).toEqual({ status: expected });
      else { expect(result[1]).toBe(''); expect(result[2].trim()).toBe('page_file_operator_failed'); }
      expect(result[1] + result[2]).not.toContain(f.enrollmentUrl);
    } finally { clearTimeout(timer); if (proc.exitCode === null) proc.kill('SIGKILL'); await proc.exited; }
  };
  try {
    install(f.reviewed);
    const before = await state();
    renameSync(secret, secret + '.withheld');
    try {
      await invoke('status', 'not_enrolled'); await invoke('verify', 'not_enrolled');
      await invoke('enroll'); expect(await state()).toEqual(before);
    } finally { renameSync(secret + '.withheld', secret); }
    console.log('PG_CONNECTED_OPERATOR: executable status/verify read-only without enrollment credential; enroll requires separate credential');
    const operator = loadPageFileOperator({ remote: false });
    for (const remote of [true, undefined]) {
      expect(() => loadPageFileOperator({ remote })).toThrow('page_file_operator_denied');
      for (const action of ['status', 'verify', 'enroll']) await expect(runPageFileOperator(
        { engine: f.engine, config: { engine: 'postgres' }, remote: remote as boolean }, operator, action)).rejects.toThrow('page_file_operator_denied');
    }
    expect(await state()).toEqual(before);
    // Each independently pinned stale field must fail without changing business state.
    for (const change of [{ revision: 'stale-reviewed-revision' }, { rawSha256: '0'.repeat(64) }]) {
      install({ ...f.reviewed, ...change }); await invoke('enroll'); expect(await state()).toEqual(before);
    }
    console.log('PG_CONNECTED_OPERATOR: remote/unset rejected; stale exact reviewed revision and bytes rejected without mutation');
    install(f.reviewed);
    await invoke('enroll', 'enrolled');
    const enrolled = await state();
    expect((await f.admin.executeRaw('SELECT binding_id FROM page_file_bindings WHERE source_id=$1', [f.source])).length).toBe(1);
    expect(enrolled.raw).toBe(before.raw);
    // Enrollment may create only the binding: pages, operations, derivatives and
    // config must be byte-for-byte unchanged from the reviewed baseline.
    expect(enrolled.rows.filter((_, i) => i !== 1)).toEqual(before.rows.filter((_, i) => i !== 1));
    await invoke('enroll', 'already_enrolled'); expect(await state()).toEqual(enrolled);
    renameSync(secret, secret + '.withheld');
    try {
      await invoke('status', 'verified'); await invoke('verify', 'verified'); expect(await state()).toEqual(enrolled);
    } finally { renameSync(secret + '.withheld', secret); }
    console.log('PG_CONNECTED_OPERATOR: executable exact enrollment and idempotent repeat; enrolled status/verify read-only without credential');
  } finally { if (ownsAnchor) rmSync(anchorPath); }
}
