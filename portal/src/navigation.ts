export interface PortalLocation {
  source: string;
  path: string;
  folder: string;
  wiki?: string;
}

export function parsePortalLocation(search: string): PortalLocation {
  const params = new URLSearchParams(search);
  return {
    ...(params.get('wiki') ? { wiki: params.get('wiki')! } : {}),
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

/** Preserve the resolver target verbatim; aliases and ACLs belong to the API. */
export function buildWikiHref(source: string, target: string): string {
  return `/portal?${new URLSearchParams({ source, wiki: target })}`;
}

export function parentPath(path: string): string {
  return path.split('/').filter(Boolean).slice(0, -1).join('/');
}

export function isPreviewable(path: string): boolean {
  return /\.(md|markdown|txt)$/i.test(path);
}
