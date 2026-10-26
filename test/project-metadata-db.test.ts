import { test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });

test('real PGLite roundtrip preserves metadata and refuses incomplete replacement', async () => {
    await engine.executeRaw("INSERT INTO sources (id,name) VALUES ('shared','shared') ON CONFLICT DO NOTHING");
    const fm='status: active\nshort_title: Synthetic project\ndomain: digital/data-domains/test\nlead: hcm/employees/test\njira_sync: false\ncustom: preserve';
    const opts={sourceId:'shared',remote:true,noEmbed:true};
    const md=`---\ntype: project\n${fm}\n---\n# Synthetic project\n\nBody to preserve.`;
    const first=await importFromContent(engine,'projects/fixture',md,opts);
    expect(first.status).toBe('imported');
    const before=await engine.getPage('projects/fixture', {sourceId:'shared'});
    expect(before?.frontmatter.jira_sync).toBe(false);
    expect(before?.frontmatter.custom).toBe('preserve');
    await expect(importFromContent(engine,'projects/fixture',md.replace('lead: hcm/employees/test\n',''),opts)).rejects.toThrow('lead');
    const after=await engine.getPage('projects/fixture', {sourceId:'shared'});
    expect(after).toEqual(before);
},30000);
