import { describe, expect, test } from 'bun:test';
import { KNOWN_CONFIG_KEYS, KNOWN_CONFIG_KEY_PREFIXES } from '../src/core/config.ts';

describe('cross-source edge config keys', () => {
  test('feature flag and per-source policy prefix are registered', () => {
    expect(KNOWN_CONFIG_KEYS).toContain('cross_source_edges');
    expect(KNOWN_CONFIG_KEYS).toContain('cross_source_edges.enabled');
    expect(KNOWN_CONFIG_KEY_PREFIXES).toContain('cross_source_edges.policy.');
    expect(KNOWN_CONFIG_KEY_PREFIXES.some((prefix) =>
      'cross_source_edges.policy.shared'.startsWith(prefix),
    )).toBe(true);
  });
});
