import { marked } from 'marked';

export interface OutlineItem {
  id: string;
  text: string;
  level: number;
}

export interface RenderedMarkdown {
  html: string;
  outline: OutlineItem[];
}

const WIKI_PREFIX = 'gbrain-wiki:';

function escapeText(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char] || char);
}

function preprocessWikilinks(markdown: string): string {
  return markdown.replace(/\[\[([^\]]+)\]\]/g, (_match, raw: string) => {
    const separator = raw.indexOf('|');
    const target = (separator >= 0 ? raw.slice(0, separator) : raw).trim();
    const label = (separator >= 0 ? raw.slice(separator + 1) : target).trim();
    return `[${label.replace(/[\[\]]/g, '')}](${WIKI_PREFIX}${encodeURIComponent(target)})`;
  });
}

function safeSlug(text: string, used: Set<string>): string {
  const base = text
    .toLocaleLowerCase('ru')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '') || 'section';
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) candidate = `${base}-${suffix++}`;
  used.add(candidate);
  return candidate;
}

function sanitizeHtml(html: string, documentTitle = ''): RenderedMarkdown {
  const template = document.createElement('template');
  template.innerHTML = html;
  const firstHeading = template.content.querySelector('h1');
  if (firstHeading && documentTitle && firstHeading.textContent?.trim().toLocaleLowerCase('ru') === documentTitle.trim().toLocaleLowerCase('ru')) {
    firstHeading.remove();
  }
  const allowedTags = new Set([
    'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'A', 'STRONG', 'EM',
    'CODE', 'PRE', 'BLOCKQUOTE', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'HR', 'BR',
    'DEL', 'S', 'IMG',
  ]);
  const safeProtocols = new Set(['http:', 'https:', 'mailto:', 'tel:']);
  const outline: OutlineItem[] = [];
  const usedIds = new Set<string>();

  const all = [...template.content.querySelectorAll('*')];
  for (const node of all) {
    if (!allowedTags.has(node.tagName)) {
      node.remove();
      continue;
    }
    for (const attribute of [...node.attributes]) {
      const name = attribute.name.toLowerCase();
      const allowed =
        node.tagName === 'A' && (name === 'href' || name === 'title') ||
        node.tagName === 'IMG' && (name === 'src' || name === 'alt' || name === 'title') ||
        node.tagName === 'CODE' && name === 'class';
      if (!allowed) node.removeAttribute(attribute.name);
    }
    if (node instanceof HTMLAnchorElement) {
      const href = (node.getAttribute('href') || '').trim();
      if (href.startsWith(WIKI_PREFIX)) {
        try {
          node.dataset.wikiTarget = decodeURIComponent(href.slice(WIKI_PREFIX.length));
          node.href = '#';
          node.classList.add('wiki-link');
        } catch {
          node.removeAttribute('href');
        }
      } else if (href.startsWith('#')) {
        // Local document anchor.
      } else if (href.startsWith('//') || /[\u0000-\u001f\u007f]/.test(href)) {
        node.removeAttribute('href');
      } else {
        try {
          const url = new URL(href, window.location.origin);
          const sameOriginPath = url.origin === window.location.origin && href.startsWith('/');
          const externalAbsolute = url.origin !== window.location.origin && safeProtocols.has(url.protocol);
          if (!sameOriginPath && !externalAbsolute) {
            node.removeAttribute('href');
          } else {
            node.target = '_blank';
            node.rel = 'noopener noreferrer';
          }
        } catch {
          node.removeAttribute('href');
        }
      }
    }
    if (node instanceof HTMLImageElement) {
      const src = node.getAttribute('src') || '';
      if (!src.startsWith('/') || src.startsWith('//')) node.removeAttribute('src');
      node.loading = 'lazy';
    }
    if (/^H[1-3]$/.test(node.tagName)) {
      const text = node.textContent?.trim() || 'Раздел';
      const id = safeSlug(text, usedIds);
      node.id = id;
      outline.push({ id, text, level: Number(node.tagName.slice(1)) });
    }
  }
  return { html: template.innerHTML, outline };
}

export function stripFrontmatter(markdown: string): string {
  if (!markdown.startsWith('---')) return markdown;
  const end = markdown.indexOf('\n---', 3);
  return end >= 0 ? markdown.slice(end + 4).replace(/^\s+/, '') : markdown;
}

export function renderMarkdown(markdown: string, documentTitle = ''): RenderedMarkdown {
  marked.setOptions({ gfm: true, breaks: false });
  const source = preprocessWikilinks(stripFrontmatter(markdown));
  const raw = marked.parse(source, { async: false }) as string;
  return sanitizeHtml(raw, documentTitle);
}

export function fallbackTitle(path: string): string {
  const name = path.split('/').pop() || path;
  return name.replace(/\.(md|markdown|txt)$/i, '').replace(/[-_]/g, ' ');
}
