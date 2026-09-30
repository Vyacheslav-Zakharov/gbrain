import { describe, expect, test } from 'bun:test';
import { buildPortalHref, buildWikiHref, isPreviewable, parentPath, parsePortalLocation } from './navigation';

describe('portal navigation', () => {
  test('wiki URLs round-trip exact targets without deriving a path', () => {
    const target = 'second:Псевдоним & + % ? "пример"#section';
    const href = buildWikiHref('origin & source', target);
    expect(parsePortalLocation(new URL(href, 'https://example.test').search)).toEqual({
      source: 'origin & source', wiki: target, path: '', folder: '',
    });
    expect(new URL(href, 'https://example.test').hash).toBe('');
  });

  test('round-trips Cyrillic source and document paths', () => {
    const href = buildPortalHref('internal-it', 'проекты/архитектура gbrain.md');
    expect(href).toContain('source=internal-it');
    expect(parsePortalLocation(href.slice(href.indexOf('?')))).toEqual({
      source: 'internal-it',
      path: 'проекты/архитектура gbrain.md',
      folder: '',
    });
  });

  test('document path takes precedence over stale folder', () => {
    expect(parsePortalLocation('?source=shared&path=a/b.md&folder=old')).toEqual({
      source: 'shared', path: 'a/b.md', folder: '',
    });
  });

  test('builds a folder deep link without a path parameter', () => {
    expect(buildPortalHref('shared', '', 'digital/systems')).toBe('/portal?source=shared&folder=digital%2Fsystems');
  });

  test('normalizes parent paths and preview extensions', () => {
    expect(parentPath('a/b/c.md')).toBe('a/b');
    expect(parentPath('root.md')).toBe('');
    expect(isPreviewable('readme.MD')).toBe(true);
    expect(isPreviewable('report.pdf')).toBe(false);
  });
});
