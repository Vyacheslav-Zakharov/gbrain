import { describe, expect, test } from 'bun:test';
import {
  classifyPortalSearchMatch,
  cleanPortalSearchSnippet,
  comparePortalSearchResults,
  extractPortalAliases,
  isPortalCountedDocument,
  isPortalVisibleDirectory,
} from '../src/portal-usability';

describe('Portal search usability', () => {
  test('ranks title matches above body-only matches', () => {
    const query = 'equipment defects';
    const title = classifyPortalSearchMatch({ query, title: 'Equipment defects', slug: 'projects/equipment-defects', chunkText: 'Overview' });
    const body = classifyPortalSearchMatch({ query, title: 'Meeting notes', slug: 'notes/meeting', chunkText: 'Discussed equipment defects' });
    expect(title.match).toBe('title');
    expect(title.rank).toBeGreaterThan(body.rank);
    expect([body, title].sort(comparePortalSearchResults)[0]).toEqual(title);
  });

  test('distinguishes path, heading, and body matches', () => {
    expect(classifyPortalSearchMatch({ query: 'alpha beta', title: 'Overview', slug: 'projects/alpha-beta', chunkText: 'Other text' }).match).toBe('path');
    expect(classifyPortalSearchMatch({ query: 'alpha beta', title: 'Overview', slug: 'projects/overview', chunkText: '## Alpha beta\nDetails' }).match).toBe('heading');
    expect(classifyPortalSearchMatch({ query: 'alpha beta', title: 'Overview', slug: 'projects/overview', chunkText: 'Mentions alpha beta in prose' }).match).toBe('content');
  });

  test('builds a query-centred snippet without markdown or broken words', () => {
    const raw = '---\ntitle: Example\n---\n## Intro\nUnrelated opening text. The equipment defects workflow assigns owners and deadlines. More details follow.';
    const snippet = cleanPortalSearchSnippet(raw, 'equipment defects', 90);
    expect(snippet).toContain('equipment defects');
    expect(snippet).not.toContain('---');
    expect(snippet).not.toContain('##');
    expect(snippet.length).toBeLessThanOrEqual(93);
  });
});

describe('Portal tree counts', () => {
  test('excludes governance and template files from user document counts', () => {
    expect(isPortalCountedDocument('projects/overview.md')).toBe(true);
    expect(isPortalCountedDocument('projects/report.pdf')).toBe(true);
    expect(isPortalCountedDocument('AGENTS.md')).toBe(false);
    expect(isPortalCountedDocument('docs/README.md')).toBe(false);
    expect(isPortalCountedDocument('_templates/page.md')).toBe(false);
    expect(isPortalCountedDocument('generated/search-index.json')).toBe(false);
  });

  test('hides technical directories from the knowledge-section count', () => {
    expect(isPortalVisibleDirectory('projects')).toBe(true);
    expect(isPortalVisibleDirectory('_templates')).toBe(false);
    expect(isPortalVisibleDirectory('_attachments')).toBe(false);
    expect(isPortalVisibleDirectory('generated')).toBe(false);
  });
});

describe('Portal wikilink aliases', () => {
  test('extracts inline and YAML-list aliases from frontmatter', () => {
    expect(extractPortalAliases('---\naliases: [projects/old-one, "projects/old-two"]\n---\n# Page')).toEqual([
      'projects/old-one',
      'projects/old-two',
    ]);
    expect(extractPortalAliases('---\naliases:\n  - projects/legacy-page\n  - "projects/older-page"\nstatus: active\n---')).toEqual([
      'projects/legacy-page',
      'projects/older-page',
    ]);
  });
});
