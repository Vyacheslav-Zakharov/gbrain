import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { parseMarkdown } from '../src/core/markdown.ts';
import { extractEntityRefs, extractPageLinks } from '../src/core/link-extraction.ts';

// Read the actual hosted capture payload, not a parallel hand-written fixture.
const source = ts.createSourceFile('fixture.ts', readFileSync(new URL('./e2e/helpers/page-file-connected-source.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
let content = '';
function visit(node: ts.Node) {
  if (ts.isCallExpression(node) && node.expression.getText(source) === 'writeFileSync'
    && node.arguments[0]?.getText(source) === 'captureInput' && ts.isStringLiteral(node.arguments[1])) content = node.arguments[1].text;
  ts.forEachChild(node, visit);
}
visit(source);

test('hosted capture input yields a canonical markdown candidate with default configuration', async () => {
  expect(content).not.toBe('');
  const parsed = parseMarkdown(content, 'sibling.md');
  const refs = extractEntityRefs(parsed.compiled_truth);
  expect(refs).toHaveLength(1);
  // Basename-only refs are intentionally opt-in and never become markdown edges.
  expect(refs[0].needsResolution).not.toBe(true);
  const resolver = { resolve: async () => null } as Parameters<typeof extractPageLinks>[4];
  const result = await extractPageLinks('sibling', parsed.compiled_truth, parsed.frontmatter, parsed.type, resolver);
  expect(refs[0].slug).toBe('concepts/capture-target');
  expect(result.candidates).toContainEqual(expect.objectContaining({ targetSlug: 'concepts/capture-target', linkSource: 'markdown' }));
});

test('original bare hosted reference cannot produce the asserted markdown provenance even if basename is enabled', async () => {
  const resolver = { resolve: async () => null, resolveBasenameMatches: async () => ['connected'] } as Parameters<typeof extractPageLinks>[4];
  const disabled = await extractPageLinks('sibling', 'Captured publication with [[connected]].', {}, 'concept', resolver);
  expect(disabled.candidates).toEqual([]);
  const enabled = await extractPageLinks('sibling', 'Captured publication with [[connected]].', {}, 'concept', resolver, { globalBasename: true });
  expect(enabled.candidates).toContainEqual(expect.objectContaining({ targetSlug: 'connected', linkSource: 'wikilink-resolved' }));
  expect(enabled.candidates.some(candidate => candidate.linkSource === 'markdown')).toBe(false);
});
