import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
const usePostgres = process.env.GBRAIN_NATIVE_TEST_POSTGRES === '1';
const primaryDimensions = usePostgres ? 1280 : 1536;
import { runEmbedCore } from '../src/commands/embed.ts';
import { embedBatch } from '../src/core/embedding.ts';
import { importFromContent, importCodeFile } from '../src/core/import-file.ts';
import { reembedPageWithContextualRetrieval } from '../src/core/contextual-retrieval-service.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { searchSelectedText } from '../src/core/selected-text-embedding.ts';
import type { ResolvedColumn } from '../src/core/types.ts';
import { embedStaleForSource } from '../src/core/embed-stale.ts';
import { selectedTextEngine } from '../src/core/selected-text-embedding.ts';
import { checkEmbedStaleness } from '../src/core/onboard/checks.ts';
import { captureMetric } from '../src/core/onboard/impact-capture.ts';

const selected: ResolvedColumn = { name: 'embedding_g768', type: 'vector', dimensions: 768, embeddingModel: 'google:gemini-embedding-001' };
let engine: PGLiteEngine | PostgresEngine;
beforeAll(async () => {
  engine = usePostgres ? new PostgresEngine() : new PGLiteEngine();
  await engine.connect(usePostgres ? {database_url:'postgresql://postgres@127.0.0.1:32770/selected_native',poolSize:1} : {});
  await engine.initSchema();
  if (usePostgres) await engine.executeRaw('ALTER TABLE content_chunks ALTER COLUMN embedding TYPE vector(1280)');
  await engine.executeRaw('ALTER TABLE content_chunks ADD COLUMN embedding_g768 vector(768)');
  await engine.putPage('selected-test', { title: 'Selected test', type: 'note', compiled_truth: 'hello', timeline: '', frontmatter: {} });
}, 60000);
afterAll(async () => { await engine.disconnect(); });

describe('selected text embedding column', () => {
  test('R1 native backfill preserves primary space', async () => {
    await engine.setConfig('search_embedding_column', selected.name);
    await engine.setConfig('embedding_columns', JSON.stringify({[selected.name]:{provider:selected.embeddingModel,dimensions:768,type:'vector'}}));
    await engine.upsertChunks('selected-test',[{chunk_index:0,chunk_text:'old',chunk_source:'compiled_truth',embedding:new Float32Array(primaryDimensions).fill(.1)}]);
    const before=await engine.executeRaw('SELECT embedding::text FROM content_chunks');
    configureGateway({embedding_model:'google:gemini-embedding-001',embedding_dimensions:1280,env:{GOOGLE_GENERATIVE_AI_API_KEY:'test'}});
    __setEmbedTransportForTests(async (args:any)=>({values:args.values,warnings:[],embeddings:args.values.map(()=>Array(args.providerOptions.google.outputDimensionality).fill(.2)),usage:{tokens:0}}));
    try {
      expect((await embedStaleForSource(engine,'default',{embeddingSignature:'google:gemini-embedding-001:1280'})).embedded).toBe(1);
      expect(await engine.countStaleChunks({embeddingColumn:selected})).toBe(0);
      expect(await engine.executeRaw('SELECT embedding::text FROM content_chunks')).toEqual(before);
    } finally {__setEmbedTransportForTests(null);resetGateway();await engine.executeRaw('DELETE FROM content_chunks');}
  });
  test('R3 readiness and cost backlog follow selected vectors', async () => {
    await engine.upsertChunks('selected-test',[{chunk_index:0,chunk_text:'old',chunk_source:'compiled_truth',embedding:new Float32Array(primaryDimensions).fill(.1)}]);
    try {
      expect((await checkEmbedStaleness(engine)).check.status).toBe('warn');
      expect(await captureMetric(engine,'stale_count')).toBe(1);
      expect(await (await selectedTextEngine(engine)).sumStaleChunkChars()).toBe(3);
    } finally {await engine.executeRaw('DELETE FROM content_chunks');}
  });
  for (const runner of ['cli','backfill']) for (const boundary of ['transport','write']) test(`R4 ${runner} concurrent edit at ${boundary}`, async () => {
    await engine.upsertChunks('selected-test',[{chunk_index:0,chunk_text:'old input',chunk_source:'compiled_truth'}]);
    const edit=()=>engine.upsertChunks('selected-test',[
      {chunk_index:0,chunk_text:'new concurrent text',chunk_source:'compiled_truth'},
      {chunk_index:1,chunk_text:'concurrently added',chunk_source:'compiled_truth'},
    ]);
    configureGateway({embedding_model:'google:gemini-embedding-001',embedding_dimensions:1280,env:{GOOGLE_GENERATIVE_AI_API_KEY:'test'}});
    const original=engine.executeRaw.bind(engine);
    let edited=false;
    engine.executeRaw=(async (sql:string,...args:any[])=>{
      if(boundary==='write' && /UPDATE content_chunks cc/.test(sql) && /RETURNING/.test(sql) && !edited){edited=true;await edit();}
      return (original as any)(sql,...args);
    }) as typeof engine.executeRaw;
    __setEmbedTransportForTests(async(args:any)=>{
      if(boundary==='transport'){edited=true;await edit();}
      return {values:args.values,warnings:[],embeddings:args.values.map(()=>Array(768).fill(.3)),usage:{tokens:0}};
    });
    try {
      if (runner === 'cli') await runEmbedCore(engine,{stale:true,sourceId:'default'});
      else expect((await embedStaleForSource(engine,'default')).done).toBe(false);
      expect(edited).toBe(true);
      const rows=await engine.getChunks('selected-test',{embeddingColumn:selected});
      expect(rows.length).toBe(2);
      expect(rows[0].chunk_text).toBe('new concurrent text');
      expect(rows[0].embedding).toBeNull();
    } finally {engine.executeRaw=original;__setEmbedTransportForTests(null);resetGateway();await engine.executeRaw('DELETE FROM content_chunks');}
  });
  test('markdown import writes selected Google vectors through its real transaction', async () => {
    await engine.setConfig('search_embedding_column', selected.name);
    await engine.setConfig('embedding_columns', JSON.stringify({ [selected.name]: { type: 'vector', dimensions: 768, provider: selected.embeddingModel } }));
    configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'test', GOOGLE_GENERATIVE_AI_API_KEY: 'test' } });
    const models: string[] = [];
    __setEmbedTransportForTests(async (args: any) => {
      models.push(args.model.modelId);
      return { values: args.values, warnings: [], embeddings: args.values.map(() => Array(args.model.modelId === 'gemini-embedding-001' ? 768 : 1536).fill(0.2)), usage: { tokens: 0 } };
    });
    try {
      const result = await importFromContent(engine, 'import-selected', '# Example\n\nA synthetic document for embedding verification.', { sourceId: 'default' });
      expect(result.status).not.toBe('skipped');
      expect(models).toEqual(['gemini-embedding-001']);
      const chunks = await engine.getChunks('import-selected', { embeddingColumn: selected });
      expect(chunks[0].embedding?.length).toBe(768);
      expect((await engine.executeRaw("SELECT embedding_signature FROM pages WHERE slug = 'import-selected'"))[0].embedding_signature).toBeNull();
      await importFromContent(engine, 'import-selected', '# Example\n\nChanged synthetic document.', { sourceId: 'default', noEmbed: true });
      expect((await engine.getChunks('import-selected', { embeddingColumn: selected }))[0].embedding).toBeNull();
      expect(models.length).toBe(1);
      await engine.executeRaw("DELETE FROM pages WHERE slug = 'import-selected'");
    } finally { __setEmbedTransportForTests(null); resetGateway(); }
  });
  test('code import selects Google and reuses unchanged selected vectors', async () => {
    configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'test', GOOGLE_GENERATIVE_AI_API_KEY: 'test' } });
    const models: string[] = [];
    __setEmbedTransportForTests(async (args: any) => {
      models.push(args.model.modelId);
      return { values: args.values, warnings: [], embeddings: args.values.map(() => Array(args.model.modelId === 'gemini-embedding-001' ? 768 : 1536).fill(0.2)), usage: { tokens: 0 } };
    });
    try {
      const content = 'export function example() { return 42; }';
      const result = await importCodeFile(engine, 'example.ts', content, { sourceId: 'default' });
      expect(models).toEqual(['gemini-embedding-001']);
      expect((await engine.getChunks(result.slug, { embeddingColumn: selected }))[0].embedding?.length).toBe(768);
      await importCodeFile(engine, 'example.ts', content, { sourceId: 'default', force: true });
      expect(models.length).toBe(1);
      await engine.executeRaw('DELETE FROM pages WHERE slug = $1', [result.slug]);
    } finally { __setEmbedTransportForTests(null); resetGateway(); }
  });
  test('contextual reembedding preserves primary bytes and same-slug foreign source', async () => {
    await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('foreign-test', 'Foreign test')");
    for (const sourceId of ['default', 'foreign-test']) {
      await engine.putPage('cr-selected', { title: 'Context', type: 'note', compiled_truth: 'Context text', timeline: '', frontmatter: {} }, { sourceId });
      await engine.upsertChunks('cr-selected', [{ chunk_index: 0, chunk_text: 'Context text', chunk_source: 'compiled_truth', embedding: new Float32Array(primaryDimensions).fill(0.125) }], { sourceId });
    }
    const before = await engine.executeRaw("SELECT p.source_id, cc.embedding::text AS primary FROM content_chunks cc JOIN pages p ON p.id=cc.page_id WHERE p.slug='cr-selected' ORDER BY p.source_id");
    configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'test', GOOGLE_GENERATIVE_AI_API_KEY: 'test' } });
    const models: string[] = [];
    __setEmbedTransportForTests(async (args: any) => {
      models.push(args.model.modelId);
      return { values: args.values, warnings: [], embeddings: args.values.map(() => Array(args.model.modelId === 'gemini-embedding-001' ? 768 : 1536).fill(0.2)), usage: { tokens: 0 } };
    });
    try {
      const result = await reembedPageWithContextualRetrieval({ engine, pageSlug: 'cr-selected', sourceId: 'default', globalMode: 'title' });
      expect(result.kind).toBe('success');
      expect(models).toEqual(['gemini-embedding-001']);
      expect((await engine.getChunks('cr-selected', { sourceId: 'default', embeddingColumn: selected }))[0].embedding?.length).toBe(768);
      expect((await engine.getChunks('cr-selected', { sourceId: 'foreign-test', embeddingColumn: selected }))[0].embedding).toBeNull();
      expect(await engine.executeRaw("SELECT p.source_id, cc.embedding::text AS primary FROM content_chunks cc JOIN pages p ON p.id=cc.page_id WHERE p.slug='cr-selected' ORDER BY p.source_id")).toEqual(before);
    } finally {
      __setEmbedTransportForTests(null); resetGateway();
      await engine.executeRaw("DELETE FROM pages WHERE slug='cr-selected'");
      await engine.executeRaw("DELETE FROM sources WHERE id='foreign-test'");
    }
  });
  test('ordinary unselected text updates invalidate Google vectors and preserve unchanged bytes', async () => {
    const slug = 'ordinary-selected';
    const base = { chunk_index: 0, chunk_text: 'original', chunk_source: 'compiled_truth' as const };
    await engine.putPage(slug, { title: 'Ordinary', type: 'note', compiled_truth: 'original', timeline: '', frontmatter: {} });
    await engine.upsertChunks(slug, [{ ...base, embedding: new Float32Array(primaryDimensions).fill(0.1) }]);
    await engine.upsertChunks(slug, [{ ...base, embedding: new Float32Array(768).fill(0.2) }], { embeddingColumn: selected });
    const before = await engine.executeRaw('SELECT embedding::text AS primary, embedding_g768::text AS selected FROM content_chunks WHERE page_id=(SELECT id FROM pages WHERE slug=$1)', [slug]);
    await engine.upsertChunks(slug, [base]);
    expect(await engine.executeRaw('SELECT embedding::text AS primary, embedding_g768::text AS selected FROM content_chunks WHERE page_id=(SELECT id FROM pages WHERE slug=$1)', [slug])).toEqual(before);
    await engine.upsertChunks(slug, [{ ...base, chunk_text: 'edited without embedding' }]);
    expect((await engine.getChunks(slug, { embeddingColumn: selected }))[0].embedding).toBeNull();
    await engine.executeRaw('DELETE FROM pages WHERE slug=$1', [slug]);
  });
  test('document batches override model and dimensions without changing global gateway', async () => {
    configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'test', GOOGLE_GENERATIVE_AI_API_KEY: 'test', GEMINI_API_KEY: 'test' } });
    const calls: any[] = [];
    __setEmbedTransportForTests(async (args: any) => {
      calls.push(args);
      return { values: args.values, warnings: [], embeddings: args.values.map(() => Array(768).fill(0.1)), usage: { tokens: 0 } };
    });
    try {
      await embedBatch(['document'], { embeddingModel: selected.embeddingModel, dimensions: 768 });
      expect(calls[0].model.modelId).toBe('gemini-embedding-001');
      expect(calls[0].providerOptions.google.outputDimensionality).toBe(768);
      expect(calls[0].providerOptions.google.taskType).toBeUndefined();
    } finally { __setEmbedTransportForTests(null); resetGateway(); }
  });
  test('writes selected vector without replacing legacy vector and invalidates selected on text change', async () => {
    const base = { chunk_index: 0, chunk_text: 'hello', chunk_source: 'compiled_truth' as const };
    await engine.upsertChunks('selected-test', [{ ...base, embedding: new Float32Array(primaryDimensions).fill(0.1) }]);
    await engine.upsertChunks('selected-test', [{ ...base, embedding: new Float32Array(768).fill(0.2) }], { embeddingColumn: selected });
    const rows = await engine.executeRaw('SELECT vector_dims(embedding) AS legacy, vector_dims(embedding_g768) AS selected FROM content_chunks');
    expect(rows[0]).toEqual({ legacy: primaryDimensions, selected: 768 });
    expect(await engine.countStaleChunks({ embeddingColumn: selected })).toBe(0);
    await engine.upsertChunks('selected-test', [{ ...base, chunk_text: 'changed' }], { embeddingColumn: selected });
    expect(await engine.countStaleChunks({ embeddingColumn: selected })).toBe(1);
    expect((await engine.listStaleChunks({ embeddingColumn: selected }))[0].chunk_text).toBe('changed');
  });
  test('native stale run resolves DB-selected Google column, not legacy credentials', async () => {
    await engine.setConfig('search_embedding_column', selected.name);
    await engine.setConfig('embedding_columns', JSON.stringify({ [selected.name]: { type: 'vector', dimensions: 768, provider: selected.embeddingModel } }));
    configureGateway({ embedding_model: 'zeroentropyai:zembed-1', embedding_dimensions: 1280, env: { GOOGLE_GENERATIVE_AI_API_KEY: 'test' } });
    let calls = 0;
    __setEmbedTransportForTests(async (args: any) => {
      calls++;
      expect(args.model.modelId).toBe('gemini-embedding-001');
      return { values: args.values, warnings: [], embeddings: args.values.map(() => Array(768).fill(0.3)), usage: { tokens: 0 } };
    });
    try {
      const result = await runEmbedCore(engine, { stale: true, sourceId: 'default' });
      expect(result.embedded).toBe(1);
      expect(calls).toBe(1);
      expect(await engine.countStaleChunks({ embeddingColumn: selected })).toBe(0);
      const repeat = await runEmbedCore(engine, { slug: 'selected-test', sourceId: 'default' });
      expect(repeat.embedded).toBe(0);
      const all = await runEmbedCore(engine, { all: true, sourceId: 'default' });
      expect(all.embedded).toBe(1);
    } finally { __setEmbedTransportForTests(null); resetGateway(); }
  });
  test('diagnostic vector search uses selected query space and column', async () => {
    configureGateway({embedding_model:'zeroentropyai:zembed-1',embedding_dimensions:1280,env:{GOOGLE_GENERATIVE_AI_API_KEY:'test'}});
    __setEmbedTransportForTests(async (args:any)=>{
      expect(args.model.modelId).toBe('gemini-embedding-001');
      expect(args.providerOptions.google.outputDimensionality).toBe(768);
      return {values:args.values,warnings:[],embeddings:args.values.map(()=>Array(768).fill(.3)),usage:{tokens:0}};
    });
    try {expect((await searchSelectedText(engine,'synthetic query',{sourceId:'default',limit:2}))[0].slug).toBe('selected-test');}
    finally {__setEmbedTransportForTests(null);resetGateway();}
  });
});
