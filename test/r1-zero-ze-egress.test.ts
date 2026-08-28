import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { DEFAULT_EMBEDDING_DIMENSIONS, DEFAULT_EMBEDDING_MODEL } from '../src/core/ai/defaults.ts';
import { __setRerankTransportForTests, configureGateway, rerank, resetGateway } from '../src/core/ai/gateway.ts';
import { getEmbeddingColumnRegistry } from '../src/core/search/embedding-column.ts';
import { MODE_BUNDLES, SEARCH_MODES } from '../src/core/search/mode.ts';

const REPO_ROOT = resolve(import.meta.dir, '..');

afterEach(() => {
  __setRerankTransportForTests(null);
  resetGateway();
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && /\.(?:ts|mjs|sh)$/.test(path) ? [path] : [];
  });
}

function executableZeLiteralsFromSource(source: string, kind: 'ts' | 'js' | 'shell', path = 'fixture.ts'): string[] {
  const values: string[] = [];
  if (kind === 'shell') {
    for (const match of source.matchAll(/zeroentropyai:[A-Za-z0-9._${}:/-]*|https?:\/\/(?:api|dashboard)\.zeroentropy\.[A-Za-z0-9._${}:/?=&-]*/gi)) values.push(match[0]);
    return values;
  }
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, kind === 'js' ? ts.ScriptKind.JS : ts.ScriptKind.TS);
  const visit = (node: ts.Node): void => {
    const isTemplateFragment = node.kind === ts.SyntaxKind.TemplateHead
      || node.kind === ts.SyntaxKind.TemplateMiddle
      || node.kind === ts.SyntaxKind.TemplateTail;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || isTemplateFragment) {
      const text = (node as ts.LiteralLikeNode).text;
      if (/zeroentropyai:|(?:api|dashboard)\.zeroentropy\./i.test(text)) values.push(text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return values;
}

function executableZeLiterals(path: string): string[] {
  return executableZeLiteralsFromSource(
    readFileSync(path, 'utf8'),
    path.endsWith('.sh') ? 'shell' : (path.endsWith('.mjs') ? 'js' : 'ts'),
    path,
  );
}

describe('R1 zero hosted-ZE default egress contract', () => {
  test('fresh/configless embedding defaults resolve to owner-approved Google 768d', () => {
    expect(DEFAULT_EMBEDDING_MODEL).toBe('google:gemini-embedding-001');
    expect(DEFAULT_EMBEDDING_DIMENSIONS).toBe(768);
  });

  test('every shipped search mode keeps reranking disabled and off ZeroEntropy', () => {
    for (const mode of SEARCH_MODES) {
      expect(MODE_BUNDLES[mode].reranker_enabled).toBe(false);
      expect(MODE_BUNDLES[mode].reranker_model.startsWith('zeroentropyai:')).toBe(false);
    }
  });

  test('direct rerank and governed rollback metadata have no hosted-ZE fallback', () => {
    const gateway = readFileSync(join(REPO_ROOT, 'src/core/ai/gateway.ts'), 'utf8');
    const runner = readFileSync(join(REPO_ROOT, 'src/commands/r1-governed-migrate.ts'), 'utf8');
    expect(gateway).toContain("DEFAULT_RERANKER_MODEL = 'voyage:rerank-2.5'");
    expect(runner).not.toMatch(/prior_reranker_model:[^\n]*\?\?\s*['"]zeroentropyai:/);
  });

  test('clone-gated corpus helper defaults to the approved Google embedding space', () => {
    const helper = readFileSync(join(REPO_ROOT, 'scripts/run-r1-retrieval-corpus.ts'), 'utf8');
    expect(helper).toContain("const model = arg('--model') ?? 'google:gemini-embedding-001'");
    expect(helper).toContain("const dimensions = Number(arg('--dimensions') ?? '768')");
  });

  test('production executable ZE literals match the exact reviewed legacy/recipe allowlist', () => {
    const inventory: string[] = [];
    for (const root of [join(REPO_ROOT, 'src'), join(REPO_ROOT, 'scripts')]) {
      for (const path of sourceFiles(root)) {
        for (const value of executableZeLiterals(path)) {
          const digest = createHash('sha256').update(value).digest('hex');
          inventory.push(`${relative(REPO_ROOT, path)}:${digest}`);
        }
      }
    }
    inventory.sort();
    expect(inventory).toEqual([
      // Diagnostics/help only: no default routing or automatic call path.
      'src/commands/doctor.ts:324b9c347eba0c9f22109734347ed2de98e1823689b1797b7c6fb4961a2d0158',
      'src/commands/doctor.ts:8cb8ce10276d40c1f4228ff527ad9f26ac5ebd7a2ec656068b70f7a345c4e844',
      'src/commands/init.ts:4ab109292c9254273b07f1d99c4125e8b4127a867fd3594a4114be4556cd5132',
      'src/commands/init.ts:8cb8ce10276d40c1f4228ff527ad9f26ac5ebd7a2ec656068b70f7a345c4e844',
      'src/commands/models.ts:ee52db0e18422f5cd87f45628b2ea238317e37fde60affc8820cdf5711bd8744',
      // Governed source-identity/rollback assertion; never a target default.
      'src/commands/r1-governed-migrate.ts:3f5a1c09538e36bb9b5e83dba7b7ef3c7460b1033094824576c5ebd8b1c73d3f',
      'src/commands/reinit-pglite.ts:42a5233f56b94bd45b684425041c02010ee802b3b484dbc35ad0015cb055e6dd',
      // Explicit provider recipe and price catalog.
      'src/core/ai/recipes/zeroentropyai.ts:0a93f829fbc9f8f12a2ef67d84c3e93fa3d56276af5c3b45a60775a1b31754c7',
      'src/core/ai/recipes/zeroentropyai.ts:38759ad26db770408074acfd718c46efd8182b4a24e12ef6a50d9a5a1987a25b',
      'src/core/ai/recipes/zeroentropyai.ts:3fc51eae59d98fed5c8bb54f6213033ccc6dc1006b6ddd37f2ade8f5855671b5',
      'src/core/embedding-pricing.ts:3f5a1c09538e36bb9b5e83dba7b7ef3c7460b1033094824576c5ebd8b1c73d3f',
      // Governed source-model identity and fail-closed rollback detector literals; never targets.
      'src/core/r1-governed-migration.ts:3f5a1c09538e36bb9b5e83dba7b7ef3c7460b1033094824576c5ebd8b1c73d3f',
      'src/core/r1-governed-migration.ts:8cb8ce10276d40c1f4228ff527ad9f26ac5ebd7a2ec656068b70f7a345c4e844',
      // Explicit operator-invoked legacy ze-switch path; never an automatic default.
      'src/core/retrieval-upgrade-planner.ts:3f5a1c09538e36bb9b5e83dba7b7ef3c7460b1033094824576c5ebd8b1c73d3f',
      'src/core/retrieval-upgrade-planner.ts:48f06fae38df73176354b86724988ad369a7cac63f270d1b646aa2a3a7a4fde8',
      'src/core/retrieval-upgrade-planner.ts:8cb8ce10276d40c1f4228ff527ad9f26ac5ebd7a2ec656068b70f7a345c4e844',
      'src/core/retrieval-upgrade-prompt.ts:83c6f3a1e94b2ac8e7a7b4ddcf20b5f57c822bf5bafc28e66f1993180f093ebf',
    ]);
  });

  test('executable scanner catches template fragments and unquoted shell words', () => {
    expect(executableZeLiteralsFromSource('fetch(`https://api.zeroentropy.dev/${path}`); const model = `zeroentropyai:${id}`;', 'ts'))
      .toEqual(['https://api.zeroentropy.dev/', 'zeroentropyai:']);
    expect(executableZeLiteralsFromSource('MODEL=zeroentropyai:zembed-1\nURL=https://dashboard.zeroentropy.dev/${TEAM}\n', 'shell'))
      .toEqual(['zeroentropyai:zembed-1', 'https://dashboard.zeroentropy.dev/${TEAM}']);
  });

  test('fresh and custom-column registries keep Google primary unless ZE is explicit', () => {
    configureGateway({ env: {} });
    const fresh = getEmbeddingColumnRegistry({ engine: 'pglite' });
    expect(fresh.embedding).toEqual({ provider: 'google:gemini-embedding-001', dimensions: 768, type: 'vector' });

    const custom = getEmbeddingColumnRegistry({
      engine: 'pglite',
      embedding_columns: {
        embedding_legacy_explicit: { provider: 'zeroentropyai:zembed-1', dimensions: 1280, type: 'vector' },
      },
    });
    expect(custom.embedding.provider).toBe('google:gemini-embedding-001');
    expect(custom.embedding_legacy_explicit.provider).toBe('zeroentropyai:zembed-1');
  });

  test('direct configless rerank fails closed before any HTTP transport', async () => {
    let transportCalls = 0;
    __setRerankTransportForTests(async () => {
      transportCalls += 1;
      return new Response('{}', { status: 200 });
    });
    configureGateway({ env: { VOYAGE_API_KEY: 'fixture-only' } });
    try {
      await expect(rerank({ query: 'q', documents: ['d'] })).rejects.toThrow('does not declare a reranker touchpoint');
      expect(transportCalls).toBe(0);
    } finally {
      __setRerankTransportForTests(null);
    }
  });

  test('background job and cycle implementations contain no hosted-ZE executable literal', () => {
    const roots = [join(REPO_ROOT, 'src/core/minions'), join(REPO_ROOT, 'src/core/cycle')];
    const violations: string[] = [];
    for (const root of roots) {
      for (const path of sourceFiles(root)) {
        readFileSync(path, 'utf8').split(/\r?\n/).forEach((line, index) => {
          const code = line.trim();
          if (!code || code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return;
          if (code.includes('zeroentropyai:')) violations.push(`${relative(REPO_ROOT, path)}:${index + 1}: ${code}`);
        });
      }
    }
    expect(violations).toEqual([]);
  });
});
