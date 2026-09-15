import { test, expect } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { BrainEngine } from '../src/core/engine.ts';
import { withLegacyPageFileRootMutation } from '../src/core/page-file-root-gate.ts';

test('coordinated mixed-root Git fast-forward succeeds without indexing enrolled bytes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-root-transition-'));
  const root = join(dir,'checkout'); mkdirSync(root);
  const git = (...args:string[]) => execFileSync('git', ['-c','user.name=Fixture','-c','user.email=fixture@example.invalid',...args], {cwd:root, env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'},stdio:'pipe'}).toString();
  const db = new PGlite(); await db.waitReady;
  const engine = { executeRaw: async (sql:string,params:unknown[]=[]) => (await db.query(sql,params)).rows } as Pick<BrainEngine,'executeRaw'>;
  try {
    git('init','-b','main'); writeFileSync(join(root,'note.md'),'before'); writeFileSync(join(root,'other.md'),'other'); git('add','.'); git('commit','-m','base');
    git('checkout','-b','incoming'); writeFileSync(join(root,'note.md'),'after'); writeFileSync(join(root,'other.md'),'new other'); git('commit','-am','incoming'); git('checkout','main');
    await db.exec('CREATE TABLE page_file_bindings(binding_id text, canonical_root text, relative_path text, pending_op_id text, indexed_raw_sha256 text, file_generation bigint)');
    await db.query('INSERT INTO page_file_bindings VALUES ($1,$2,$3,NULL,$4,1)', ['binding',root,'note.md','original-index']);
    const host = {root,lockDirectory:join(dir,'locks'),topology:'single-host-local' as const};
    await withLegacyPageFileRootMutation(engine,root,()=>git('pull','--ff-only','.','incoming'),host);
    expect(readFileSync(join(root,'note.md'),'utf8')).toBe('after');
    expect(readFileSync(join(root,'other.md'),'utf8')).toBe('new other');
    expect((await db.query<any>('SELECT * FROM page_file_bindings')).rows[0].indexed_raw_sha256).toBe('original-index');
    await withLegacyPageFileRootMutation(engine,root,()=>git('pull','--ff-only','.','incoming'),host);
    const { assertPageFileRootClean, reconcilePageFileRootTransition } = await import('../src/core/page-file-root-transition.ts');
    assertPageFileRootClean(host);
    const generation = (await db.query<any>('SELECT file_generation FROM page_file_bindings')).rows[0].file_generation;
    expect(Number(generation)).toBe(3);
    // Pending operation authority wins before Git or durable root invalidation.
    await db.exec("UPDATE page_file_bindings SET pending_op_id='pending-operation'");
    let ran = false;
    await expect(withLegacyPageFileRootMutation(engine,root,()=>{ ran=true; },host)).rejects.toThrow('pending_recovery');
    expect(ran).toBe(false);
    expect((await db.query<any>('SELECT pending_op_id FROM page_file_bindings')).rows[0].pending_op_id).toBe('pending-operation');
    await db.exec('UPDATE page_file_bindings SET pending_op_id=NULL');
    // Dirty local files are preserved; never autostash/reset just to permit pull.
    writeFileSync(join(root,'other.md'),'local work');
    await expect(withLegacyPageFileRootMutation(engine,root,()=>{ ran=true; },host)).rejects.toThrow('page_file_root_worktree_dirty');
    expect(readFileSync(join(root,'other.md'),'utf8')).toBe('local work');
    git('add','.'); git('commit','-m','preserve local work');
    // A callback failing after installing bytes leaves durable fail-closed state.
    await expect(withLegacyPageFileRootMutation(engine,root,()=>{
      writeFileSync(join(root,'note.md'),'interrupted authoritative bytes');
      throw new Error('interrupted');
    },host)).rejects.toThrow('interrupted');
    expect(()=>assertPageFileRootClean(host)).toThrow('page_file_root_sync_required');
    await expect(withLegacyPageFileRootMutation(engine,root,()=>{ran=true;},host)).rejects.toThrow('page_file_root_sync_required');
    await reconcilePageFileRootTransition(engine,host);
    assertPageFileRootClean(host);
    expect(readFileSync(join(root,'note.md'),'utf8')).toBe('interrupted authoritative bytes');
    expect((await db.query<any>('SELECT indexed_raw_sha256 FROM page_file_bindings')).rows[0].indexed_raw_sha256).toBe('original-index');
  } finally { await db.close(); rmSync(dir,{recursive:true,force:true}); }
}, 20_000);
