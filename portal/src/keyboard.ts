export interface ShortcutLike {
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  code: string;
  key: string;
}

export function isGlobalSearchShortcut(event: ShortcutLike): boolean {
  return !event.altKey
    && (event.ctrlKey || event.metaKey)
    && (event.code === 'KeyK' || event.key.toLowerCase() === 'k');
}
