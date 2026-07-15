export interface PortalLocation {
  source: string;
  path: string;
  folder: string;
}

export function parsePortalLocation(search: string): PortalLocation {
  const params = new URLSearchParams(search);
  return {
    source: params.get('source') || '',
    path: params.get('path') || '',
    folder: params.get('path') ? '' : params.get('folder') || '',
  };
}

export function buildPortalHref(source: string, path = '', folder = ''): string {
  const params = new URLSearchParams();
  if (source) params.set('source', source);
  if (path) params.set('path', path);
  else if (folder) params.set('folder', folder);
  return `/portal${params.size ? `?${params.toString()}` : ''}`;
}

export function parentPath(path: string): string {
  return path.split('/').filter(Boolean).slice(0, -1).join('/');
}

export function isPreviewable(path: string): boolean {
  return /\.(md|markdown|txt)$/i.test(path);
}
