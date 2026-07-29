import { describe, expect, test } from 'bun:test';
import { isGlobalSearchShortcut } from './keyboard';

const shortcut = (overrides: Partial<Parameters<typeof isGlobalSearchShortcut>[0]> = {}) => ({
  ctrlKey: true,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  code: 'KeyK',
  key: 'k',
  ...overrides,
});

describe('global search shortcut', () => {
  test('accepts Ctrl+K in a Latin keyboard layout', () => {
    expect(isGlobalSearchShortcut(shortcut())).toBe(true);
  });

  test('accepts the physical K key in a non-Latin keyboard layout', () => {
    expect(isGlobalSearchShortcut(shortcut({ key: 'л' }))).toBe(true);
  });

  test('accepts Meta+K and rejects unrelated or modified shortcuts', () => {
    expect(isGlobalSearchShortcut(shortcut({ ctrlKey: false, metaKey: true }))).toBe(true);
    expect(isGlobalSearchShortcut(shortcut({ code: 'KeyL', key: 'l' }))).toBe(false);
    expect(isGlobalSearchShortcut(shortcut({ altKey: true }))).toBe(false);
    expect(isGlobalSearchShortcut(shortcut({ shiftKey: true, key: 'K' }))).toBe(false);
    expect(isGlobalSearchShortcut(shortcut({ metaKey: true }))).toBe(false);
  });
});
