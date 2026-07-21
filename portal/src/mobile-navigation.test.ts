import { describe, expect, test } from 'bun:test';
import { keepExplorerOpenAfterFolderNavigation } from './mobile-navigation';

describe('mobile explorer navigation', () => {
  test('keeps the drawer open while traversing folders on mobile', () => {
    expect(keepExplorerOpenAfterFolderNavigation(true)).toBe(true);
  });

  test('does not keep drawer state open on desktop', () => {
    expect(keepExplorerOpenAfterFolderNavigation(false)).toBe(false);
  });
});
