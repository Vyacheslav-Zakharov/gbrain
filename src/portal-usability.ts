export type PortalSearchMatch = 'title' | 'path' | 'heading' | 'content' | 'name';

export interface PortalSearchRank {
  match: PortalSearchMatch;
  rank: number;
  score?: number;
  title?: string;
  path?: string;
}

function normalizeSearchText(value: string): string {
  return String(value || '').normalize('NFKC').toLocaleLowerCase('ru-RU').replace(/\s+/g, ' ').trim();
}

export function classifyPortalSearchMatch(input: {
  query: string;
  title?: string;
  slug?: string;
  path?: string;
  chunkText?: string;
  score?: number;
}): PortalSearchRank {
  const query = normalizeSearchText(input.query);
  const title = normalizeSearchText(input.title || '');
  const path = normalizeSearchText(input.path || input.slug || '')
    .replace(/\.(md|markdown|txt)$/i, '')
    .replace(/[\/_-]+/g, ' ');
  const headings = String(input.chunkText || '')
    .split(/\r?\n/)
    .filter((line) => /^\s{0,3}#{1,6}\s+/.test(line))
    .map((line) => normalizeSearchText(line.replace(/^\s{0,3}#{1,6}\s+/, '')));

  let match: PortalSearchMatch = 'content';
  let rank = 100;
  if (title === query) {
    match = 'title';
    rank = 600;
  } else if (title.startsWith(query)) {
    match = 'title';
    rank = 550;
  } else if (title.includes(query)) {
    match = 'title';
    rank = 500;
  } else if (path.includes(query)) {
    match = 'path';
    rank = 400;
  } else if (headings.some((heading) => heading.includes(query))) {
    match = 'heading';
    rank = 300;
  }
  return { match, rank, score: input.score, title: input.title, path: input.path || input.slug };
}

function stripSearchMarkup(raw: string): string {
  return String(raw || '')
    .replace(/^---\s*\n[\s\S]*?\n---(?:\s*\n|$)/, ' ')
    .replace(/```[^\n]*\n([\s\S]*?)```/g, ' $1 ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/[{}\[\]"]/g, ' ')
    .replace(/[*_~>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function cleanPortalSearchSnippet(raw: string, query: string, maxLength = 220): string {
  const clean = stripSearchMarkup(raw);
  if (!clean) return '';
  const normalizedQuery = normalizeSearchText(query);
  const lower = normalizeSearchText(clean);
  const found = lower.indexOf(normalizedQuery);
  let start = found >= 0 ? Math.max(0, found - Math.floor(maxLength * 0.28)) : 0;
  let end = Math.min(clean.length, start + maxLength);
  if (start > 0) {
    const nextSpace = clean.indexOf(' ', start);
    start = nextSpace >= 0 && nextSpace < end ? nextSpace + 1 : start;
  }
  if (end < clean.length) {
    const previousSpace = clean.lastIndexOf(' ', end);
    end = previousSpace > start ? previousSpace : end;
  }
  const excerpt = clean.slice(start, end).trim();
  return `${start > 0 ? '…' : ''}${excerpt}${end < clean.length ? '…' : ''}`;
}

export function comparePortalSearchResults(a: PortalSearchRank, b: PortalSearchRank): number {
  if (a.rank !== b.rank) return b.rank - a.rank;
  const scoreDelta = Number(b.score || 0) - Number(a.score || 0);
  if (scoreDelta) return scoreDelta;
  return String(a.title || a.path || '').localeCompare(String(b.title || b.path || ''), 'ru');
}

const GOVERNANCE_FILES = new Set([
  'agents.md',
  'claude.md',
  'resolver.md',
  'readme.md',
  'schema.md',
  'log.md',
]);

export function isPortalVisibleDirectory(relativePath: string): boolean {
  const normalized = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const name = normalized.split('/').filter(Boolean).at(-1)?.toLowerCase() || '';
  return !['_templates', '_attachments', 'generated'].includes(name);
}

export function isPortalCountedDocument(relativePath: string): boolean {
  const normalized = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = normalized.split('/').filter(Boolean);
  const name = parts.at(-1)?.toLowerCase() || '';
  if (!name || GOVERNANCE_FILES.has(name)) return false;
  if (parts.some((part) => part === '_templates' || part === 'generated')) return false;
  return true;
}
