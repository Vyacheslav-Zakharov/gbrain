import { describe, expect, test } from 'bun:test';
import { isGlobalSearchShortcut } from './keyboard';

describe('global search shortcut', () => {
  test('accepts Ctrl+K in a Latin keyboard layout', () => {
    expect(isGlobalSearchShortcut({ ctrlKey: true, metaKey: false, altKey: false, code: 'KeyK', key: 'k' })).toBe(true);
  });

  test('accepts the physical K key in a non-Latin keyboard layout', () => {
    expect(isGlobalSearchShortcut({ ctrlKey: true, metaKey: false, altKey: false, code: 'KeyK', key: 'л' })).toBe(true);
  });

  test('accepts Meta+K and rejects unrelated or modified shortcuts', () => {
    expect(isGlobalSearchShortcut({ ctrlKey: false, metaKey: true, altKey: false, code: 'KeyK', key: 'k' })).toBe(true);
    expect(isGlobalSearchShortcut({ ctrlKey: true, metaKey: false, altKey: false, code: 'KeyL', key: 'l' })).toBe(false);
    expect(isGlobalSearchShortcut({ ctrlKey: true, metaKey: false, altKey: true, code: 'KeyK', key: 'k' })).toBe(false);
  });
});
