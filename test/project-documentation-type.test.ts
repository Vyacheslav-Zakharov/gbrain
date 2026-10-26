import { test, expect } from 'bun:test';
import { parseMarkdown } from '../src/core/markdown.ts';
import { importFromContent } from '../src/core/import-file.ts';

const pack={page_types:[{name:'project',path_prefixes:['projects/']},{name:'note',path_prefixes:['notes/']}]};
test('explicit documentation type wins over project path without project metadata', async()=>{
 const content='---\ntype: note\ncustom: keep\n---\n# Project documentation\n\nSeparate technical documentation.';
 const writes:any[]=[];
 const engine:any=new Proxy({}, {get(_,k){
  if(k==='then')return undefined;
  if(k==='transaction')return async(f:any)=>f(engine);
  if(k==='putPage')return async(...args:any[])=>{writes.push(args);return {id:1,slug:args[0],...args[1]}};
  if(k==='getTags'||k==='executeRaw')return async()=>[];
  return async()=>null;
 }});
 expect(parseMarkdown(content,'projects/example/documentation.md',{activePack:pack}).type).toBe('note');
 await importFromContent(engine,'projects/example/documentation',content,{sourceId:'shared',remote:true,noEmbed:true,activePack:pack});
 expect(writes).toHaveLength(1); expect(writes[0][1].type).toBe('note');
 expect(writes[0][1].frontmatter).toEqual({custom:'keep'});
});
test('actual project outside project prefix must report every missing field and classification guidance',async()=>{
 const engine:any=new Proxy({}, {get(_,k){ if(k==='then')return undefined;if(k==='transaction')return async(f:any)=>f(engine); if(k==='executeRaw'||k==='getTags')return async()=>[]; return async()=>null; }});
 let error:any;
 try {await importFromContent(engine,'notes/actual-project','---\ntype: project\n---\n# Actual project',{sourceId:'shared',remote:true,noEmbed:true});}catch(e){error=e;}
 expect(error?.message).toContain('PROJECT_METADATA_REQUIRED');
 for(const k of ['status','short_title','domain','lead','jira_sync'])expect(error.message).toContain(k);
 expect(error.message).toContain('documentation');
});
