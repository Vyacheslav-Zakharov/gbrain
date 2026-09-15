/** Exact, article-scoped fragment resolution. Never normalize arbitrary targets. */
export function resolveArticleAnchor(root: HTMLElement, hash: string): HTMLElement | null {
  if (!hash.startsWith('#') || hash.length === 1) return null;
  let id: string;
  try { id = decodeURIComponent(hash.slice(1)); } catch { return null; }
  const headings = [...root.querySelectorAll<HTMLElement>('h1[id],h2[id],h3[id],h4[id],h5[id],h6[id]')];
  const canonical = headings.filter((heading) => heading.id === id);
  if (canonical.length) return canonical.length === 1 ? canonical[0] : null;
  const aliases = headings.filter((heading) => {
    try {
      const values: unknown = JSON.parse(heading.dataset.headingAliases || '[]');
      return Array.isArray(values) && values.includes(id);
    } catch { return false; }
  });
  return aliases.length === 1 ? aliases[0] : null;
}

export function scrollArticleAnchor(container: HTMLElement | null, hash: string): boolean {
  const root = container?.querySelector<HTMLElement>('.markdown-body');
  if (!container || !root) return false;
  const target = resolveArticleAnchor(root, hash);
  if (!target) return false;
  container.scrollTo({
    top: container.scrollTop + target.getBoundingClientRect().top - container.getBoundingClientRect().top - 16,
    behavior: 'instant',
  });
  return true;
}
