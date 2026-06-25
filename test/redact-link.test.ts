import { describe, expect, test } from 'bun:test';
import { redactLink, redactLinks, type RedactableLink } from '../src/core/redact-link.ts';

const visibleManual: RedactableLink = {
  from_slug: 'shared/from',
  to_slug: 'shared/to',
  link_type: 'discusses',
  context: 'visible context',
  link_source: 'manual-smoke',
  origin_slug: null,
  origin_field: null,
  from_source_id: 'shared',
  to_source_id: 'shared',
  origin_source_id: null,
};

describe('redactLink', () => {
  test('keeps manual/custom link_source when both endpoints are visible and no origin page exists', () => {
    const redacted = redactLink(visibleManual, ['shared'], { defaultPolicy: 'hidden' }, 'out');

    expect(redacted).toMatchObject({
      from_slug: 'shared/from',
      to_slug: 'shared/to',
      link_source: 'manual-smoke',
      context: 'visible context',
      origin_slug: null,
      origin_field: null,
      origin_source_id: null,
    });
    expect(redacted?.locked).toBeUndefined();
  });

  test('locked-stub redacts far endpoint plus context and provenance', () => {
    const row: RedactableLink = {
      ...visibleManual,
      to_slug: 'internal/secret',
      to_source_id: 'internal-accounting',
      origin_slug: 'shared/from',
      origin_source_id: 'shared',
      origin_field: 'links',
    };

    const redacted = redactLink(row, ['shared'], {
      defaultPolicy: 'hidden',
      bySource: { 'internal-accounting': 'locked-stub' },
    }, 'out');

    expect(redacted).toMatchObject({
      locked: true,
      from_slug: 'shared/from',
      to_slug: null,
      to_source_id: null,
      context: null,
      link_source: null,
      origin_slug: null,
      origin_field: null,
      origin_source_id: null,
    });
  });

  test('hidden policy drops inaccessible far endpoint rows', () => {
    const row: RedactableLink = {
      ...visibleManual,
      to_slug: 'internal/secret',
      to_source_id: 'internal-legal',
    };

    expect(redactLink(row, ['shared'], { defaultPolicy: 'hidden' }, 'out')).toBeNull();
    expect(redactLinks([row], ['shared'], { defaultPolicy: 'hidden' }, 'out')).toEqual([]);
  });

  test('redacts only origin fields when visible endpoint row has inaccessible origin page', () => {
    const row: RedactableLink = {
      ...visibleManual,
      origin_slug: 'internal/origin',
      origin_field: 'frontmatter.related',
      origin_source_id: 'internal-hr',
    };

    const redacted = redactLink(row, ['shared'], { defaultPolicy: 'hidden' }, 'out');

    expect(redacted).toMatchObject({
      from_slug: 'shared/from',
      to_slug: 'shared/to',
      context: 'visible context',
      link_source: null,
      origin_slug: null,
      origin_field: null,
      origin_source_id: null,
    });
    expect(redacted?.locked).toBeUndefined();
  });
});
