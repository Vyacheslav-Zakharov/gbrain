import { test, expect, spyOn } from 'bun:test';
import { validateSourceIngestProfile, type SourceIngestProfile } from '../src/core/source-ingest/profile-schema';
import { buildProfileAllRecords } from '../src/core/source-ingest/source-fetch';
import { FakeSourceConnector } from '../src/core/source-ingest/connectors/fake';
import { PostgresSourceConnector } from '../src/core/source-ingest/connectors/postgres';

for (const count of [0, 500]) test(`real PostgreSQL fetchAll auxiliary completion: ${count} rows`, async () => {
 const p=profile(); p.transform!.sources[0]={alias:'cs',connector:'postgres',object:'employees'};
 p.transform!.sql='SELECT mo.*, (SELECT count(*) FROM cs) AS auxiliary_count FROM mo';
 const offsets:number[]=[];
 // Only the SQL transport boundary is replaced; fetchAll and record conversion are real.
 const page=spyOn(PostgresSourceConnector.prototype as any,'fetchPage').mockImplementation(async (_object:unknown, opts:any)=>{
  offsets.push(opts.offset);
  return Array.from({length:Math.max(0,Math.min(500,count-opts.offset))},(_,i)=>({employment_id:String(opts.offset+i)}));
 });
 const primary=spyOn(FakeSourceConnector.prototype,'fetchAll').mockImplementation(async function*(){yield {records:rows.map(data=>({external_id:data.ID,data})),cursor:null};});
 try {
  const result=await buildProfileAllRecords(p,{engine,defaultConnector:'fake-source',defaultObject:'MaintenanceObjects'});
  expect(result?.length).toBe(1); expect(Number(result![0].data.auxiliary_count)).toBe(count);
  expect(offsets).toEqual(count===0?[0]:[0,500]);
 } finally {page.mockRestore();primary.mockRestore();}
},30000);

test('real PostgreSQL auxiliary page failure after full page never signals completion',async()=>{
 const p=profile();p.transform!.sources[0]={alias:'cs',connector:'postgres',object:'employees'};p.transform!.sql='SELECT * FROM mo';
 const page=spyOn(PostgresSourceConnector.prototype as any,'fetchPage').mockImplementation(async (_object:unknown,opts:any)=>{
  if(opts.offset)throw Error('postgres_next_page_failed');
  return Array.from({length:500},(_,i)=>({employment_id:String(i)}));
 });
 const primary=spyOn(FakeSourceConnector.prototype,'fetchAll').mockImplementation(async function*(){yield {records:rows.map(data=>({external_id:data.ID,data})),cursor:null};});
 try {await expect(buildProfileAllRecords(p,{engine,defaultConnector:'fake-source',defaultObject:'MaintenanceObjects'})).rejects.toThrow('postgres_next_page_failed');}
 finally {page.mockRestore();primary.mockRestore();}
});
const policy = { fields:{id:'ID',key:'Key',name:'Name',type:'Type',created:'Created',parent:'Parent',site:'Site'}, dateFormat:'MM/DD/YYYY HH:mm:ss' as const,timezone:'+05:00',rootParentValues:[''] as const,passportFields:[],anchors:[],typeAllowlist:['equipment'],scope:{sites:['A']} };
const rows = [{ID:'one',Key:'one',Name:'One',Type:'equipment',Created:null,Parent:'',Site:'A'}];
const profile = ():SourceIngestProfile => ({profile_id:'multi-guard',status:'reviewed',source_connector:'fake-source',source_object:'MaintenanceObjects',target:{approved_source_id:'shared',gbrain_type:'equipment',slug_template:'equipment/{{ ID }}'},identity:{external_id_field:'ID',display_name_field:'Name',require_explicit_resolution:true,explicit_create_ids:['one']},directory_guard:{source_alias:'mo',policy,baseline_promotion:'hold'},transform:{sources:[{alias:'cs',object:'ChecklistSteps'},{alias:'mo',object:'MaintenanceObjects'}],sql:'SELECT mo.*, cs."Title" AS detail FROM mo LEFT JOIN cs ON mo."ID" = cs."ObjectID"',primary_key_field:'ID'},update_policy:{mode:'managed_block',preserve_manual_sections:true},security:{classification:'internal',pii:false}});
test('missing guarded alias fails schema and runtime before fetching', async()=>{
 const p=profile();p.directory_guard!.source_alias='absent';
 expect(validateSourceIngestProfile(p).ok).toBe(false);
 await expect(buildProfileAllRecords(p,{engine,defaultConnector:'fake-source',defaultObject:'MaintenanceObjects'})).rejects.toThrow('guard_requires_unique_explicit_source');
});
for (const [label,sql] of [
 ['duplicate output','SELECT * FROM mo UNION ALL SELECT * FROM mo'],
 ['invented output',`SELECT 'invented' AS "ID" FROM mo`],
 ['identity field mismatch',`SELECT 'one' AS pk, 'different' AS "ID" FROM mo`],
] as const) test(label+' is refused by unchanged output identity guard',async()=>{
 const p=profile();p.transform!.sql=sql;if(label==='identity field mismatch')p.transform!.primary_key_field='pk';
 const fetch=spyOn(FakeSourceConnector.prototype,'fetchAll').mockImplementation(async function*(object){yield {records:(object==='MaintenanceObjects'?rows:[]).map(data=>({external_id:data.ID,data})),cursor:null};});
 try{await expect(buildProfileAllRecords(p,{engine,defaultConnector:'fake-source',defaultObject:'MaintenanceObjects'})).rejects.toThrow('guard_transform_identity_mismatch');}finally{fetch.mockRestore();}
},30000);
test('raw duplicate outside scope refuses before auxiliary fetch',async()=>{
 const calls:string[]=[];
 const fetch=spyOn(FakeSourceConnector.prototype,'fetchAll').mockImplementation(async function*(object){calls.push(object);yield {records:[...rows,{...rows[0],Site:'B'}].map(data=>({external_id:data.ID,data})),cursor:null};});
 try{await expect(buildProfileAllRecords(profile(),{engine,defaultConnector:'fake-source',defaultObject:'MaintenanceObjects'})).rejects.toThrow('directory_guard:');expect(calls).toEqual(['MaintenanceObjects']);}finally{fetch.mockRestore();}
});
test('auxiliary exception propagates without partial output',async()=>{
 const fetch=spyOn(FakeSourceConnector.prototype,'fetchAll').mockImplementation(async function*(object){if(object!=='MaintenanceObjects')throw Error('auxiliary_transport_failed');yield {records:rows.map(data=>({external_id:data.ID,data})),cursor:null};});
 try{await expect(buildProfileAllRecords(profile(),{engine,defaultConnector:'fake-source',defaultObject:'MaintenanceObjects'})).rejects.toThrow('auxiliary_transport_failed');}finally{fetch.mockRestore();}
});
test('primary binding drift refuses even with identical raw rows',async()=>{
 let baseline:any;
 const p=profile();p.transform!.sql='SELECT * FROM mo';
 const fetch=spyOn(FakeSourceConnector.prototype,'fetchAll').mockImplementation(async function*(object){yield {records:(object==='ChecklistSteps'?[]:rows).map(data=>({external_id:data.ID,data})),cursor:null};});
 try{
  await buildProfileAllRecords(p,{engine,defaultConnector:'fake-source',defaultObject:'MaintenanceObjects',onGuardPrepared:r=>{baseline=r.candidateBaseline;}});
  p.transform!.sources[1].object='DifferentDirectory';
  const pinned={...engine,getConfig:async(key:string)=>key===`source_ingest.directory_guard.shared.${p.profile_id}`?JSON.stringify(baseline):null};
  await expect(buildProfileAllRecords(p,{engine:pinned,defaultConnector:'fake-source',defaultObject:'MaintenanceObjects'})).rejects.toThrow('directory_guard:');
 }finally{fetch.mockRestore();}
},30000);
// Read-only engine facade; SQL transformation itself uses the real isolated PGlite worker.
const engine = {getConfig:async()=>null,executeRaw:async()=>[]} as any;
test('duplicate auxiliary aliases fail schema and fetch admission',async()=>{
 const p=profile();p.transform!.sources.push({...p.transform!.sources[0]});
 expect(validateSourceIngestProfile(p).ok).toBe(false);
 await expect(buildProfileAllRecords(p,{engine,defaultConnector:'fake-source',defaultObject:'MaintenanceObjects'})).rejects.toThrow('guard_duplicate_source_alias');
});
test('missing auxiliary fetch completion cannot masquerade as an empty table',async()=>{
 const p=profile(); p.transform!.sql='SELECT * FROM mo';
 const fetch=spyOn(FakeSourceConnector.prototype,'fetchAll').mockImplementation(async function*(object){if(object==='MaintenanceObjects')yield {records:rows.map(data=>({external_id:data.ID,data})),cursor:null};});
 try {await expect(buildProfileAllRecords(p,{engine,defaultConnector:'fake-source',defaultObject:'MaintenanceObjects'})).rejects.toThrow('missing_source_fetch');}finally{fetch.mockRestore();}
},30000);
test('unique primary alias among enrichment inputs validates and fetches real auxiliary rows', async()=>{
 const p=profile(); expect(validateSourceIngestProfile(p).issues).toEqual([]);
 const calls:string[]=[];
 const fetch=spyOn(FakeSourceConnector.prototype,'fetchAll').mockImplementation(async function*(object){calls.push(object);yield {records:(object==='MaintenanceObjects'?rows:[{ObjectID:'one',Title:'Enriched'}]).map(data=>({external_id:'ID' in data?data.ID:'step',data})),cursor:null};});
 try { const output=await buildProfileAllRecords(p,{engine,defaultConnector:'fake-source',defaultObject:'MaintenanceObjects'}); expect(output?.map(r=>[r.external_id,r.data.detail])).toEqual([['one','Enriched']]);expect(calls).toEqual(['MaintenanceObjects','ChecklistSteps']); } finally {fetch.mockRestore();}
},30000);
test('auxiliary input without complete fetch refuses instead of sampling', async()=>{
 const p=profile(); p.transform!.sources[0].connector='missing-aux';
 const fetch=spyOn(FakeSourceConnector.prototype,'fetchAll').mockImplementation(async function*(){yield {records:rows.map(data=>({external_id:data.ID,data})),cursor:null};});
 try {
  // Missing connector must fail, not silently substitute the primary snapshot.
  await expect(buildProfileAllRecords(p,{engine,defaultConnector:'fake-source',defaultObject:'MaintenanceObjects'})).rejects.toThrow('connector not found');
 } finally {fetch.mockRestore();}
});
test('auxiliary incomplete cursor refuses before SQL', async()=>{
 const fetch=spyOn(FakeSourceConnector.prototype,'fetchAll').mockImplementation(async function*(object){yield {records:(object==='MaintenanceObjects'?rows:[{ObjectID:'one',Title:'Partial'}]).map(data=>({external_id:'ID' in data?data.ID:'step',data})),cursor:object==='MaintenanceObjects'?null:'next'};});
 try {await expect(buildProfileAllRecords(profile(),{engine,defaultConnector:'fake-source',defaultObject:'MaintenanceObjects'})).rejects.toThrow('incomplete_snapshot_cursor');} finally {fetch.mockRestore();}
},30000);
