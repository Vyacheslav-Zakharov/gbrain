import {test,expect,beforeAll,afterAll} from 'bun:test';
import {PGLiteEngine} from '../src/core/pglite-engine.ts';
import {embeddingHealth} from '../src/core/text-embedding-health.ts';
let e:PGLiteEngine;
beforeAll(async()=>{e=new PGLiteEngine();await e.connect({});await e.initSchema();},60000);
afterAll(async()=>{await e?.disconnect();});
test('health counts selected vectors on active pages',async()=>{
  await e.executeRaw('ALTER TABLE content_chunks ADD COLUMN embedding_g768 vector(768)');
  await e.setConfig('search_embedding_column','embedding_g768');
  await e.setConfig('embedding_columns',JSON.stringify({embedding_g768:{type:'vector',dimensions:768,provider:'google:gemini-embedding-001'}}));
  for(const slug of ['health-active','health-deleted']){
   await e.putPage(slug,{title:slug,type:'note',compiled_truth:'text',timeline:'',frontmatter:{}});
   await e.upsertChunks(slug,[{chunk_index:0,chunk_text:'text',chunk_source:'compiled_truth',embedding:new Float32Array(1536).fill(.1)}]);
  }
  await e.executeRaw("UPDATE pages SET deleted_at=NOW() WHERE slug='health-deleted'");
  expect(await embeddingHealth(e)).toEqual({column:'embedding_g768',total:1,missing:1,coverage:0});
  expect((await e.getHealth()).embed_coverage).toBe(0);
  expect((await e.getHealth()).missing_embeddings).toBe(1);
  await e.executeRaw("UPDATE content_chunks SET embedding_g768=$1::vector WHERE page_id=(SELECT id FROM pages WHERE slug='health-active')",[JSON.stringify(Array(768).fill(.2))]);
  expect(await embeddingHealth(e)).toEqual({column:'embedding_g768',total:1,missing:0,coverage:1});
},60000);
