import { test, describe, expect, spyOn, beforeAll, beforeEach, afterAll } from 'bun:test';
import { resetPgliteState } from './helpers/reset-pglite';
import { PGLiteEngine } from '../src/core/pglite-engine';
import { FakeSourceConnector } from '../src/core/source-ingest/connectors/fake';
import { putSourceIngestProfile } from '../src/core/source-ingest/store';
import { runSourceIngestExecutor } from '../src/core/source-ingest/executor';
import { prepareDirectorySnapshot } from '../src/core/source-ingest/directory-identity-guard';
import { buildProfileSampleRecords } from '../src/core/source-ingest/source-fetch';
import { importFromContent } from '../src/core/import-file';
import type { SourceIngestProfile } from '../src/core/source-ingest/profile-schema';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
const policy = { fields: { id:'ID', key:'Key', name:'Name', type:'Type', created:'Created', parent:'Parent', site:'Site' }, dateFormat:'MM/DD/YYYY HH:mm:ss' as const, timezone:'+05:00', rootParentValues:['' as const], passportFields:[], anchors:[], typeAllowlist:['facility','equipment'], scope:{sites:['A']} };
const raw = () => [
 { ID:'root', Key:'root', Name:'Root', Type:'facility', Created:null, Parent:'', Site:'A' },
 { ID:'parent', Key:'parent', Name:'Parent', Type:'equipment', Created:null, Parent:'root', Site:'A' },
 { ID:'child', Key:'child', Name:'Child', Type:'equipment', Created:null, Parent:'parent', Site:'A' },
];
// Each scenario gets an independent engine, a fresh Git repo, and restored connector
// spies. Keep real SQL transforms: their cold PGlite workers dominate runtime.
// Splitting semantic contracts bounds each test without raising its 60s deadline.
describe.each(['bootstrap', 'privacy', 'promotion'] as const)('native guard %s', (scenario) => {
let engine: PGLiteEngine;
beforeAll(async () => {
 engine = new PGLiteEngine();
 await engine.connect({});
 await engine.initSchema();
}, 60000);
beforeEach(async () => { await resetPgliteState(engine); });
afterAll(async () => { await engine.disconnect(); });
test('preserves its publication boundaries', async () => {

 const repo = mkdtempSync(join(tmpdir(),'native-guard-'));
 const git = (...args:string[]) => execFileSync('git',args,{cwd:repo,encoding:'utf8'});
 git('init','-q'); git('config','user.name','Synthetic Test'); git('config','user.email','test@example.test'); writeFileSync(join(repo,'README.md'),'test'); git('add','.'); git('commit','-qm','seed');
 let rows = raw(); let fullReads = 0;
 const fetch = spyOn(FakeSourceConnector.prototype,'fetchAll').mockImplementation(async function* () { fullReads++; yield {records:rows.map(data=>({external_id:data.ID,data})),cursor:null}; });
 const sample = spyOn(FakeSourceConnector.prototype,'sample').mockImplementation(async()=>{throw Error('sample forbidden');});
 const changed = spyOn(FakeSourceConnector.prototype,'fetchChangedSince').mockImplementation(async function*(){throw Error('incremental forbidden');});
 try {
  await engine.executeRaw(`INSERT INTO sources(id,name,local_path) VALUES ('shared','shared',$1)`,[repo]);
  await importFromContent(engine,'facilities/root','---\ntype: facility\ntitle: Root\n---\nRoot facility',{sourceId:'shared',noEmbed:true,remote:false});
  const preview = prepareDirectorySnapshot({upstreamBinding:{connectorInstanceId:'fake-source',objectName:'directory',alias:'source',sourceTableId:null,resolvedCatalogId:null},sourceId:'shared',profileId:'directory-test',policy,records:rows,complete:true,mode:'preview'});
  if(preview.status==='stopped') throw Error(preview.diagnostics.join(','));
  const profile:SourceIngestProfile = { profile_id:'directory-test',status:'reviewed',source_connector:'fake-source',source_object:'directory',target:{approved_source_id:'shared',gbrain_type:'equipment',slug_template:'equipment/{{ ID }}'}, identity:{external_id_field:'ID',display_name_field:'Name',require_explicit_resolution:true,explicit_create_ids:['parent','child'],nonwriting_bindings:{root:{source_id:'shared',slug:'facilities/root',type:'facility',approved:true}}}, directory_guard:{source_alias:'source',policy,approved_bootstrap_hash:preview.snapshotHash,baseline_promotion:'full'}, links:[{id:'parent',type:'part_of',when:[{field:'Parent',op:'neq',value:'root'},{field:'Parent',op:'exists'}],target:{lookup:'external_id',value_field:'Parent',profile_id:'directory-test',source_id:'shared',type:'equipment'}},{id:'facility',type:'located_at',when:[{field:'Parent',op:'eq',value:'root'}],target:{lookup:'external_id',value_field:'Parent',profile_id:'directory-test',source_id:'shared',type:'facility'}}], update_policy:{mode:'managed_block',preserve_manual_sections:true},security:{classification:'internal',pii:false} };
  const key='source_ingest.directory_guard.shared.directory-test';
  await putSourceIngestProfile(engine,profile);
  const pinKey=key+'.first_bootstrap';
  if (scenario === 'bootstrap') {
  await buildProfileSampleRecords(profile,1,{engine,defaultConnector:'fake-source',defaultObject:'directory'});
  expect(await engine.getConfig(key)).toBeNull();
  expect(await engine.getConfig(pinKey)).toBeNull();
  }
  profile.directory_guard!.baseline_promotion='hold';
  profile.transform={sources:[{alias:'source',object:'directory'}],sql:'SELECT * FROM source',primary_key_field:'ID'};
  await putSourceIngestProfile(engine,profile);
  profile.update_policy.include_external_id_in_content=false;
  await putSourceIngestProfile(engine,profile);
  if (scenario === 'bootstrap') {
  const validLinks=profile.links;
  profile.links=[{id:'bad',type:'part_of',target:{lookup:'external_id',value_field:'ID',profile_id:'foreign',source_id:'shared',type:'equipment'}}];
  await putSourceIngestProfile(engine,profile);
  await expect(runSourceIngestExecutor(engine,{profile_id:profile.profile_id})).rejects.toThrow();
  expect(await engine.getConfig(pinKey)).toBeNull(); expect(await engine.getConfig(key)).toBeNull();
  profile.links=validLinks; await putSourceIngestProfile(engine,profile);
  // Fault at the actual post-preflight persistence boundary, not initial validation.
  for (const fault of ['disappear', 'change']) {
   let injected = false;
   const setConfig = engine.setConfig.bind(engine);
   const pinWrite = spyOn(engine, 'setConfig').mockImplementation(async (k, value) => {
    await setConfig(k, value);
    if (k === pinKey) {
     injected = true;
     if (fault === 'disappear') await engine.executeRaw('DELETE FROM config WHERE key=$1', [k]);
     else await setConfig(k, JSON.stringify({...JSON.parse(value), snapshotHash:'0'.repeat(64)}));
    }
   });
   try {
    await expect(runSourceIngestExecutor(engine,{profile_id:profile.profile_id,limit:1})).rejects.toThrow('bootstrap_pin');
    expect(injected).toBe(true);
    expect(await engine.executeRaw("SELECT slug FROM pages WHERE source_id='shared' AND type='equipment'")).toEqual([]);
    expect(await engine.executeRaw('SELECT * FROM links')).toEqual([]);
    expect(await engine.executeRaw('SELECT * FROM source_sync_state')).toEqual([]);
    expect(await engine.getConfig(key)).toBeNull();
    expect(git('status','--porcelain')).toBe('');
   } finally { pinWrite.mockRestore(); await engine.executeRaw('DELETE FROM config WHERE key=$1',[pinKey]); }
  }
  }
  // Rebuild the successful limited SQL pilot through the actual executor in every
  // scenario; no pages, links, sync records or bootstrap pins are hand-seeded.
  const pilot=await runSourceIngestExecutor(engine,{profile_id:profile.profile_id,limit:1});
  const pin=await engine.getConfig(pinKey);
  if (!pilot.ok || pilot.counts.written !== 1 || pin === null) {
   throw new Error('native guard fixture failed to publish its SQL pilot');
  }
  if (scenario === 'bootstrap') {
  expect(pilot.ok).toBe(true); expect(pilot.counts.written).toBe(1);
  expect(await engine.getConfig(key)).toBeNull();
  expect(pin).not.toBeNull();
  const firstHashes=await engine.executeRaw('SELECT slug,content_hash FROM pages ORDER BY slug');
  const firstVersions=await engine.executeRaw('SELECT * FROM page_versions ORDER BY id');
  const repeat=await runSourceIngestExecutor(engine,{profile_id:profile.profile_id,limit:1});
  expect(repeat.ok).toBe(true); expect(repeat.counts.unchanged).toBe(1);
  expect(await engine.executeRaw('SELECT slug,content_hash FROM pages ORDER BY slug')).toEqual(firstHashes);
  expect(await engine.executeRaw('SELECT * FROM page_versions ORDER BY id')).toEqual(firstVersions);
  expect(await engine.getConfig(pinKey)).toBe(pin);
  }
  const pilotPages=await engine.executeRaw('SELECT slug,content_hash FROM pages ORDER BY slug');
  const pilotLinks=await engine.executeRaw('SELECT * FROM links ORDER BY id');
  if (scenario === 'bootstrap') {
  for (const mutation of [{Created:'01/01/2020 00:00:00'},{Name:'Replaced',Type:'facility'}]) {
   rows=raw().map(r=>r.ID==='parent'?{...r,...mutation}:r) as any;
   const next=prepareDirectorySnapshot({upstreamBinding:preview.candidateBaseline.upstreamBinding,sourceId:'shared',profileId:profile.profile_id,policy,records:rows,complete:true,mode:'preview'});
   if(next.status==='stopped') throw Error(next.diagnostics.join(','));
   profile.directory_guard!.approved_bootstrap_hash=next.snapshotHash; await putSourceIngestProfile(engine,profile);
   await expect(buildProfileSampleRecords(profile,1,{engine,defaultConnector:'fake-source',defaultObject:'directory'})).rejects.toThrow('bootstrap_pin');
   await expect(runSourceIngestExecutor(engine,{profile_id:profile.profile_id})).rejects.toThrow('bootstrap_pin');
   expect(await engine.getConfig(key)).toBeNull(); expect(await engine.getConfig(pinKey)).toBe(pin);
   expect(await engine.executeRaw('SELECT slug,content_hash FROM pages ORDER BY slug')).toEqual(pilotPages);
   expect(await engine.executeRaw('SELECT * FROM links ORDER BY id')).toEqual(pilotLinks);
  }
  rows=raw(); profile.directory_guard!.approved_bootstrap_hash=preview.snapshotHash; await putSourceIngestProfile(engine,profile);
  for (const corrupt of ['{}','null','broken']) {
   await engine.setConfig(pinKey,corrupt);
   await expect(buildProfileSampleRecords(profile,1,{engine,defaultConnector:'fake-source',defaultObject:'directory'})).rejects.toThrow('bootstrap_pin');
   await expect(runSourceIngestExecutor(engine,{profile_id:profile.profile_id})).rejects.toThrow('bootstrap_pin');
  }
  await engine.executeRaw('DELETE FROM config WHERE key=$1',[pinKey]);
  await expect(buildProfileSampleRecords(profile,1,{engine,defaultConnector:'fake-source',defaultObject:'directory'})).rejects.toThrow('rebaseline_required');
  await expect(runSourceIngestExecutor(engine,{profile_id:profile.profile_id})).rejects.toThrow('rebaseline_required');
  await engine.setConfig(pinKey,pin!);
  }
  if (scenario === 'privacy') {
  // The privacy path requires both exact owner profile and successful identity binding.
  await engine.executeRaw(`UPDATE pages SET frontmatter=jsonb_set(frontmatter,'{source_ingest,profile_id}','"foreign"'::jsonb) WHERE source_id='shared' AND slug='equipment/parent'`);
  await expect(runSourceIngestExecutor(engine,{profile_id:profile.profile_id})).rejects.toThrow('guarded_canonical_owner_conflict');
  await engine.executeRaw(`UPDATE pages SET frontmatter=jsonb_set(frontmatter,'{source_ingest,profile_id}','"directory-test"'::jsonb) WHERE source_id='shared' AND slug='equipment/parent'`);
  profile.identity.explicit_create_ids=['child']; profile.identity.existing_slug_map={parent:'equipment/parent'}; await putSourceIngestProfile(engine,profile);
  for (const result of ['pending','skipped','archived','failed']) {
   await engine.executeRaw(`UPDATE source_sync_state SET last_result=$2 WHERE approved_source_id='shared' AND profile_id=$1`,[profile.profile_id,result]);
   await expect(runSourceIngestExecutor(engine,{profile_id:profile.profile_id})).rejects.toThrow('guarded_canonical_owner_conflict');
   expect(await engine.executeRaw('SELECT slug,content_hash FROM pages ORDER BY slug')).toEqual(pilotPages);
   expect(await engine.executeRaw('SELECT * FROM links ORDER BY id')).toEqual(pilotLinks);
   expect(await engine.getConfig(key)).toBeNull();
   expect(await engine.getConfig(pinKey)).toBe(pin);
  }
  await engine.executeRaw(`UPDATE source_sync_state SET last_result='success' WHERE approved_source_id='shared' AND profile_id=$1`,[profile.profile_id]);
  }
  if (scenario === 'promotion') {
  profile.identity.explicit_create_ids=['parent','child']; delete profile.identity.existing_slug_map;
  delete profile.transform; profile.directory_guard!.baseline_promotion='full'; await putSourceIngestProfile(engine,profile);
  const first=await runSourceIngestExecutor(engine,{profile_id:profile.profile_id,changed_since:true});
  expect(first.ok).toBe(true); expect(first.counts.written).toBe(1);
  expect(first.results.map(r=>r.external_id)).toEqual(['parent','child']);
  expect(await engine.getPage('equipment/root',{sourceId:'shared'})).toBeNull();
  const baseline=await engine.getConfig(key); expect(baseline).not.toBeNull();
  const second=await runSourceIngestExecutor(engine,{profile_id:profile.profile_id}); expect(second.ok).toBe(true); expect(second.counts.unchanged).toBe(2);
  const pagesBefore=await engine.executeRaw('SELECT slug,content_hash FROM pages ORDER BY slug');
  const linksBefore=await engine.executeRaw('SELECT * FROM links ORDER BY id');
  for (const bad of [ [...raw(),raw()[2]], raw().map(r=>r.ID==='child'?{...r,Key:'drift'}:r), raw().map(r=>r.ID==='child'?{...r,Parent:'missing'}:r) ]) {
   rows=bad;
   await expect(runSourceIngestExecutor(engine,{profile_id:profile.profile_id,limit:1,changed_since:true})).rejects.toThrow();
   expect(await engine.getConfig(key)).toBe(baseline);
   expect(await engine.executeRaw('SELECT slug,content_hash FROM pages ORDER BY slug')).toEqual(pagesBefore);
   expect(await engine.executeRaw('SELECT * FROM links ORDER BY id')).toEqual(linksBefore);
  }
  rows=raw();
  // Same top-level profile cannot reuse A's baseline or bootstrap for upstream B.
  profile.transform={sources:[{alias:'source',object:'directory-B'}],sql:'SELECT * FROM source',primary_key_field:'ID'};
  await putSourceIngestProfile(engine,profile);
  await expect(runSourceIngestExecutor(engine,{profile_id:profile.profile_id})).rejects.toThrow('binding');
  const emptyBaselineEngine = Object.create(engine);
  emptyBaselineEngine.getConfig = async (k:string) => k===key ? null : engine.getConfig(k);
  await expect(buildProfileSampleRecords(profile,1,{engine:emptyBaselineEngine,guardMode:'run',defaultConnector:'fake-source',defaultObject:'directory'})).rejects.toThrow('bootstrap_required');
  delete profile.transform; await putSourceIngestProfile(engine,profile);
  rows=raw().map(r=>r.ID==='child'?{...r,Name:'Updated'}:r);
  await runSourceIngestExecutor(engine,{profile_id:profile.profile_id,limit:1}); expect(await engine.getConfig(key)).toBe(baseline);
  profile.directory_guard!.baseline_promotion='hold'; await putSourceIngestProfile(engine,profile);
  await runSourceIngestExecutor(engine,{profile_id:profile.profile_id}); expect(await engine.getConfig(key)).toBe(baseline);
  // Subsequent deliberate failed-sync/adoption regression uses visible owner refs.
  profile.update_policy.include_external_id_in_content=true; await putSourceIngestProfile(engine,profile);
  await runSourceIngestExecutor(engine,{profile_id:profile.profile_id});
  // A graph durability failure cannot promote a full run.
  profile.directory_guard!.baseline_promotion='full'; await putSourceIngestProfile(engine,profile);
  const failGraph=spyOn(engine,'addLinksBatch').mockRejectedValue(new Error('synthetic graph failure'));
  try { const failed=await runSourceIngestExecutor(engine,{profile_id:profile.profile_id}); expect(failed.ok).toBe(false); expect(await engine.getConfig(key)).toBe(baseline); } finally { failGraph.mockRestore(); }
  // SQL cannot hide a raw duplicate, even when the SQL returns no selected records.
  profile.transform={sources:[{alias:'source',object:'directory'}],sql:'SELECT * FROM source WHERE false',primary_key_field:'ID'};
  rows=[...raw(),raw()[2]]; await putSourceIngestProfile(engine,profile);
  await expect(runSourceIngestExecutor(engine,{profile_id:profile.profile_id,limit:1,changed_since:true})).rejects.toThrow('duplicate_id');
  rows=raw(); profile.transform.sql='SELECT * FROM source UNION ALL SELECT * FROM source'; await putSourceIngestProfile(engine,profile);
  await expect(runSourceIngestExecutor(engine,{profile_id:profile.profile_id,limit:1})).rejects.toThrow('guard_transform_identity_mismatch');
  expect(await engine.getConfig(key)).toBe(baseline);
  profile.identity.explicit_create_ids=[];
  profile.identity.existing_slug_map={parent:'equipment/parent',child:'equipment/child'};
  // Valid SQL canaries with no executor limit must never advance the raw baseline.
  rows=raw().map(r=>r.ID==='parent'?{...r,Name:'SQL updated'}:r);
  for (const sql of ['SELECT * FROM source WHERE false', `SELECT * FROM source WHERE "ID" = 'parent' LIMIT 1`]) {
   profile.transform.sql=sql; await putSourceIngestProfile(engine,profile);
   const before=await engine.executeRaw('SELECT slug,content_hash FROM pages ORDER BY slug');
   const run=await runSourceIngestExecutor(engine,{profile_id:profile.profile_id});
   expect(run.ok).toBe(true);
   expect(run.results.length).toBe(sql.includes('false')?0:1);
   expect(await engine.getConfig(key)).toBe(baseline);
   if(sql.includes('false')) expect(await engine.executeRaw('SELECT slug,content_hash FROM pages ORDER BY slug')).toEqual(before);
   else { expect(run.results[0].slug).toBe('equipment/parent'); expect(run.counts.written).toBe(1); expect(await engine.executeRaw('SELECT slug,content_hash FROM pages ORDER BY slug')).not.toEqual(before); }
  }
  delete profile.transform;
  rows=raw().map(r=>r.ID==='child'?{...r,Name:'Selection update'}:r);
  for (const selected of ['absent','parent']) {
   profile.selection={include:[{field:'ID',op:'eq',value:selected}]}; await putSourceIngestProfile(engine,profile);
   const before=await engine.executeRaw('SELECT slug,content_hash FROM pages ORDER BY slug');
   const run=await runSourceIngestExecutor(engine,{profile_id:profile.profile_id});
   expect(run.ok).toBe(true); expect(run.results.length).toBe(selected==='absent'?0:1);
   expect(await engine.getConfig(key)).toBe(baseline);
   if(selected==='absent') expect(await engine.executeRaw('SELECT slug,content_hash FROM pages ORDER BY slug')).toEqual(before);
  }
  expect(fullReads).toBeGreaterThan(5);
  }
 } finally { fetch.mockRestore();sample.mockRestore();changed.mockRestore();rmSync(repo,{recursive:true,force:true}); }
},60000);
});
