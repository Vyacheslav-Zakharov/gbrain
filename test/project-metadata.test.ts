import { test, expect } from 'bun:test';
import { importFromContent } from '../src/core/import-file.ts';
import type { BrainEngine } from '../src/core/engine.ts';

function engineFixture() {
  const writes: any[] = [];
  const engine: any = new Proxy({}, { get(_, key) {
    if (key === 'then') return undefined;
    if (key === 'transaction') return async (fn: any) => fn(engine);
    if (key === 'putPage') return async (...args: any[]) => { writes.push(args); return { id: 1, slug: args[0], ...args[1] }; };
    if (key === 'getTags' || key === 'executeRaw') return async () => [];
    return async () => null;
  }});
  return { engine: engine as BrainEngine, writes };
}
const body = '# Fixture project\n\nA synthetic project for metadata validation.';
const opts = { sourceId: 'shared', remote: true, noEmbed: true };
const valid: Record<string, unknown> = {status:'active',short_title:'Test project',domain:'digital/data-domains/test',lead:'hcm/employees/test',jira_sync:true};
const markdown = (fm: Record<string, unknown>) => `---\ntype: project\n${Object.entries(fm).map(([k,v]) => `${k}: ${JSON.stringify(v)}`).join('\n')}\n---\n${body}`;
test('rejects invalid values including quoted booleans and placeholders as one batch', async () => {
  const {engine,writes} = engineFixture();
  const bad = {...valid,status:'nonsense',short_title:'   ',domain:'<domain>',lead:'owner',jira_sync:'false'};
  await expect(importFromContent(engine,'projects/invalid',markdown(bad),opts)).rejects.toThrow('PROJECT_METADATA_INVALID');
  expect(writes).toHaveLength(0);
});
for (const flag of [true,false]) for (const status of ['active','stable','draft','paused']) {
  test(`persists explicit jira_sync=${flag} status=${status} without defaulting`, async () => {
    const {engine,writes} = engineFixture();
    const fm = {...valid,status,jira_sync:flag,custom:'preserve me'};
    const result=await importFromContent(engine,'projects/valid',markdown(fm),opts);
    expect(result.status).toBe('imported');
    expect(writes).toHaveLength(1);
    expect(writes[0][1].frontmatter).toEqual(fm);
  });
}
for (const key of Object.keys(valid)) test(`missing ${key} refuses before write`,async () => {
  const {engine,writes}=engineFixture();
  const fm={...valid}; delete fm[key];
  await expect(importFromContent(engine,'projects/missing',markdown(fm),opts)).rejects.toThrow(key);
  expect(writes).toHaveLength(0);
});
test('projects/other exempts domain and lead only', async () => {
  const {engine,writes}=engineFixture();
  await importFromContent(engine,'projects/other',markdown({status:'active',short_title:'Other',jira_sync:true}),opts);
  expect(writes).toHaveLength(1);
  await expect(importFromContent(engine,'projects/other',markdown({status:'active',short_title:'Other'}),opts)).rejects.toThrow('jira_sync');
});
test('non-project templates and non-shared projects remain outside contract',async () => {
  for (const [sourceId,content] of [['shared',`---\ntype: note\n---\n${body}`],['personal',markdown({})]]) {
    const {engine,writes}=engineFixture();
    await importFromContent(engine,'templates/test',content,{...opts,sourceId});
    expect(writes).toHaveLength(1);
  }
});
test('prefix-inferred project cannot bypass required metadata by omitting type',async () => {
  const {engine,writes}=engineFixture();
  await expect(importFromContent(engine,'projects/inferred',body,{...opts,activePack:{page_types:[{name:'project',path_prefixes:['projects/']}]}})).rejects.toThrow('PROJECT_METADATA_REQUIRED');
  expect(writes).toHaveLength(0);
});
test('owner is preserved but never substitutes for lead',async () => {
  const {engine,writes}=engineFixture();
  const fm: Record<string, unknown>={...valid,owner:'hcm/employees/test'}; delete fm.lead;
  await expect(importFromContent(engine,'projects/owner',markdown(fm),opts)).rejects.toThrow('lead');
  expect(writes).toHaveLength(0);
});
for (const status of ['idea','on-hold','done','dropped','retired']) test(`legacy status ${status} is not silently rewritten`,async () => {
  const {engine,writes}=engineFixture();
  await importFromContent(engine,'projects/legacy',markdown({...valid,status}),opts);
  expect(writes[0][1].frontmatter.status).toBe(status);
});
test('remote shared project reports all missing fields together before persistence', async () => {
  const {engine,writes} = engineFixture();
  let error: any;
  try { await importFromContent(engine, 'projects/test-metadata', `---\ntype: project\n---\n${body}`, opts); }
  catch (e) { error = e; }
  expect(error?.message).toContain('PROJECT_METADATA_REQUIRED');
  for (const key of ['status','short_title','domain','lead','jira_sync']) expect(error.message).toContain(key);
  expect(error.message).toContain('shared:projects/test-metadata');
  expect(writes).toHaveLength(0);
});
