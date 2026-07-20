import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { portalApi } from './api';
import { fallbackTitle, renderMarkdown, type OutlineItem } from './markdown';
import { buildPortalHref, isPreviewable, parentPath, parsePortalLocation } from './navigation';
import { isGlobalSearchShortcut } from './keyboard';
import type {
  Backlink,
  ContextResponse,
  FileResponse,
  PortalSession,
  PortalSource,
  RecentDocument,
  SearchResult,
  TreeEntry,
} from './types';

const LAST_SOURCE_KEY = 'gbrain.portal.lastSource';
const RECENTS_KEY = 'gbrain.portal.recents';
const FAVORITES_KEY = 'gbrain.portal.favorites';

function scopedStorageKey(base: string, email: string): string {
  return `${base}:${encodeURIComponent(email.trim().toLowerCase())}`;
}

function stored<T>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) as T : fallback;
  } catch {
    return fallback;
  }
}

function persist(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage is optional */ }
}

function humanBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, bytes || 0)} Б`;
  const units = ['КБ', 'МБ', 'ГБ'];
  let value = bytes / 1024;
  let unit = units[0];
  for (let i = 1; value >= 1024 && i < units.length; i += 1) {
    value /= 1024;
    unit = units[i];
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}

function fileKind(entry: Pick<TreeEntry, 'name' | 'type' | 'markdown'>): string {
  if (entry.type === 'dir') return 'folder';
  const ext = entry.name.split('.').pop()?.toLowerCase();
  if (entry.markdown) return 'doc';
  if (ext === 'pdf') return 'pdf';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext || '')) return 'image';
  if (['xlsx', 'xls', 'csv'].includes(ext || '')) return 'table';
  return 'file';
}

function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    menu: <><path d="M4 7h16M4 12h16M4 17h16" /></>,
    search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></>,
    folder: <><path d="M3 7.5h7l2 2h9v9.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M3 9.5v-3a2 2 0 0 1 2-2h4l2 3" /></>,
    doc: <><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v5h5M9 12h6M9 16h6" /></>,
    file: <><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v5h5" /></>,
    pdf: <><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v5h5M8.5 15h7" /></>,
    image: <><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="8.5" cy="9" r="1.5" /><path d="m4 18 5-5 3 3 2-2 6 5" /></>,
    table: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M9 4v16" /></>,
    chevron: <><path d="m9 18 6-6-6-6" /></>,
    back: <><path d="m15 18-6-6 6-6" /></>,
    copy: <><rect x="8" y="8" width="11" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h2" /></>,
    star: <><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9z" /></>,
    download: <><path d="M12 3v12M7 10l5 5 5-5M4 20h16" /></>,
    panel: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /></>,
    close: <><path d="m6 6 12 12M18 6 6 18" /></>,
    external: <><path d="M14 4h6v6M20 4l-9 9" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></>,
  };
  return <svg aria-hidden="true" viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{paths[name] || paths.file}</svg>;
}

function readLocation() {
  return parsePortalLocation(window.location.search);
}

function writeLocation(source: string, path: string, folder: string, replace = false): void {
  const href = buildPortalHref(source, path, folder);
  window.history[replace ? 'replaceState' : 'pushState']({}, '', href);
}

export function PortalApp() {
  const [session, setSession] = useState<PortalSession | null>(null);
  const [sources, setSources] = useState<PortalSource[]>([]);
  const [sourceId, setSourceId] = useState('');
  const [folder, setFolder] = useState('');
  const [entries, setEntries] = useState<TreeEntry[]>([]);
  const [treeSummary, setTreeSummary] = useState({ sections: 0, documents: 0, complete: true });
  const [sourceSummary, setSourceSummary] = useState({ sections: 0, documents: 0, complete: true });
  const [document, setDocument] = useState<FileResponse | null>(null);
  const [binary, setBinary] = useState<TreeEntry | null>(null);
  const [context, setContext] = useState<ContextResponse | null>(null);
  const [loadingTree, setLoadingTree] = useState(false);
  const [loadingDocument, setLoadingDocument] = useState(false);
  const [error, setError] = useState('');
  const [explorerOpen, setExplorerOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [mobile, setMobile] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [activeSearchIndex, setActiveSearchIndex] = useState(0);
  const [recents, setRecents] = useState<RecentDocument[]>([]);
  const [favorites, setFavorites] = useState<RecentDocument[]>([]);
  const [copied, setCopied] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const searchTriggerRef = useRef<HTMLButtonElement>(null);
  const searchDialogRef = useRef<HTMLDivElement>(null);
  const searchWasOpen = useRef(false);
  const articleRef = useRef<HTMLElement>(null);
  const storageKeys = useMemo(() => session ? {
    lastSource: scopedStorageKey(LAST_SOURCE_KEY, session.email),
    recents: scopedStorageKey(RECENTS_KEY, session.email),
    favorites: scopedStorageKey(FAVORITES_KEY, session.email),
  } : null, [session]);

  const selectedSource = useMemo(() => sources.find((source) => source.id === sourceId), [sources, sourceId]);
  const rendered = useMemo(() => document ? renderMarkdown(document.content, document.title) : { html: '', outline: [] as OutlineItem[] }, [document]);
  const isFavorite = useMemo(() => document ? favorites.some((item) => item.source === document.source && item.path === document.path) : false, [document, favorites]);

  const loadFolder = useCallback(async (nextSource: string, nextFolder: string, push = true) => {
    if (!nextSource) return;
    setLoadingTree(true);
    setError('');
    try {
      const data = await portalApi.tree(nextSource, nextFolder);
      setSourceId(nextSource);
      setFolder(nextFolder);
      setEntries(data.entries);
      setTreeSummary(data.summary);
      setSourceSummary(data.sourceSummary);
      setDocument(null);
      setBinary(null);
      setContext(null);
      if (storageKeys) localStorage.setItem(storageKeys.lastSource, nextSource);
      if (push) writeLocation(nextSource, '', nextFolder);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось открыть папку');
    } finally {
      setLoadingTree(false);
      setExplorerOpen(false);
    }
  }, [storageKeys]);

  const rememberDocument = useCallback((file: FileResponse) => {
    setRecents((current) => {
      const next = [{ source: file.source, sourceName: file.sourceName, path: file.path, title: file.title, openedAt: Date.now() }, ...current.filter((item) => item.source !== file.source || item.path !== file.path)].slice(0, 12);
      if (storageKeys) persist(storageKeys.recents, next);
      return next;
    });
  }, [storageKeys]);

  const openDocument = useCallback(async (nextSource: string, path: string, push = true) => {
    if (!nextSource || !path) return;
    if (!isPreviewable(path)) {
      const name = path.split('/').pop() || path;
      portalApi.tree(nextSource, parentPath(path)).then((data) => {
        setEntries(data.entries);
        setTreeSummary(data.summary);
        setSourceSummary(data.sourceSummary);
      }).catch(() => {
        setEntries([]);
        setTreeSummary({ sections: 0, documents: 0, complete: true });
      });
      setSourceId(nextSource);
      setFolder(parentPath(path));
      setDocument(null);
      setContext(null);
      setBinary({ name, path, type: 'file', markdown: false, size: 0 });
      if (push) writeLocation(nextSource, path, '');
      return;
    }
    setLoadingDocument(true);
    setError('');
    try {
      const [file, nextContext, tree] = await Promise.all([
        portalApi.file(nextSource, path),
        portalApi.context(nextSource, path).catch(() => null),
        portalApi.tree(nextSource, parentPath(path)).catch(() => null),
      ]);
      setSourceId(nextSource);
      setFolder(parentPath(path));
      setDocument(file);
      setBinary(null);
      setContext(nextContext);
      if (tree) {
        setEntries(tree.entries);
        setTreeSummary(tree.summary);
        setSourceSummary(tree.sourceSummary);
      }
      if (storageKeys) localStorage.setItem(storageKeys.lastSource, nextSource);
      rememberDocument(file);
      if (push) writeLocation(nextSource, path, '');
      requestAnimationFrame(() => articleRef.current?.scrollTo({ top: 0 }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось открыть документ');
    } finally {
      setLoadingDocument(false);
      setExplorerOpen(false);
    }
  }, [rememberDocument, storageKeys]);

  const hydrateLocation = useCallback(async (replace = false) => {
    if (!sources.length || !storageKeys) return;
    const location = readLocation();
    const remembered = localStorage.getItem(storageKeys.lastSource) || '';
    const nextSource = sources.some((item) => item.id === location.source)
      ? location.source
      : sources.some((item) => item.id === remembered) ? remembered : sources[0].id;
    if (location.path) {
      await openDocument(nextSource, location.path, false);
      if (replace && nextSource !== location.source) writeLocation(nextSource, location.path, '', true);
    } else {
      await loadFolder(nextSource, location.folder, false);
      if (replace && nextSource !== location.source) writeLocation(nextSource, '', location.folder, true);
    }
  }, [loadFolder, openDocument, sources, storageKeys]);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 900px)');
    const sync = () => setMobile(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);

  useEffect(() => {
    if (!storageKeys) return;
    setRecents(stored<RecentDocument[]>(storageKeys.recents, []));
    setFavorites(stored<RecentDocument[]>(storageKeys.favorites, []));
  }, [storageKeys]);

  useEffect(() => {
    Promise.all([portalApi.sources(), portalApi.session().catch(() => null)])
      .then(([nextSources, nextSession]) => {
        setSources(nextSources);
        setSession(nextSession);
        if (!nextSources.length) setError('Для вашей учётной записи пока нет доступных источников.');
      })
      .catch((caught) => setError(caught instanceof Error ? caught.message : 'Не удалось загрузить портал'));
  }, []);

  useEffect(() => { if (sources.length && storageKeys) void hydrateLocation(true); }, [sources, storageKeys, hydrateLocation]);
  useEffect(() => {
    const onPopState = () => void hydrateLocation(false);
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [hydrateLocation]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isGlobalSearchShortcut(event)) {
        event.preventDefault();
        setSearchOpen(true);
      }
      if (event.key === 'Escape') {
        setSearchOpen(false);
        setExplorerOpen(false);
        setContextOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (searchOpen) requestAnimationFrame(() => searchRef.current?.focus());
    else if (searchWasOpen.current) requestAnimationFrame(() => searchTriggerRef.current?.focus());
    searchWasOpen.current = searchOpen;
  }, [searchOpen]);

  useEffect(() => {
    if (!searchOpen || searchQuery.trim().length < 2) {
      setSearchResults([]);
      setActiveSearchIndex(0);
      setSearchLoading(false);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setSearchLoading(true);
      portalApi.search(searchQuery.trim(), controller.signal)
        .then((results) => {
          setSearchResults(results);
          setActiveSearchIndex(0);
        })
        .catch((caught) => { if (caught instanceof Error && caught.name !== 'AbortError') setError(caught.message); })
        .finally(() => setSearchLoading(false));
    }, 220);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [searchOpen, searchQuery]);

  const chooseSource = (nextSource: string) => void loadFolder(nextSource, '', true);
  const chooseEntry = (entry: TreeEntry) => {
    if (entry.type === 'dir') void loadFolder(sourceId, entry.path, true);
    else if (entry.markdown) void openDocument(sourceId, entry.path, true);
    else {
      setDocument(null);
      setContext(null);
      setBinary(entry);
      writeLocation(sourceId, entry.path, '');
      setExplorerOpen(false);
    }
  };

  const chooseSearchResult = (result: SearchResult) => {
    setSearchOpen(false);
    setSearchQuery('');
    void openDocument(result.source, result.path, true);
  };

  const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (!searchResults.length) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveSearchIndex((index) => (index + 1) % searchResults.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveSearchIndex((index) => (index - 1 + searchResults.length) % searchResults.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      chooseSearchResult(searchResults[activeSearchIndex]);
    }
  };

  const trapSearchFocus = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return;
    const focusable = [...(searchDialogRef.current?.querySelectorAll<HTMLElement>('input, button, a[href], [tabindex]:not([tabindex="-1"])') || [])]
      .filter((element) => !element.hasAttribute('disabled') && element.getAttribute('aria-hidden') !== 'true');
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && window.document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && window.document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const resolveWiki = async (target: string) => {
    try {
      const result = await portalApi.resolveLink(target, sourceId);
      if (!result.found || !result.source || !result.path) throw new Error(`Страница «${target}» не найдена в доступных источниках`);
      await openDocument(result.source, result.path, true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось открыть ссылку');
    }
  };

  const onArticleClick = (event: React.MouseEvent<HTMLElement>) => {
    const anchor = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[data-wiki-target]');
    if (!anchor) return;
    event.preventDefault();
    void resolveWiki(anchor.dataset.wikiTarget || '');
  };

  const toggleFavorite = () => {
    if (!document) return;
    setFavorites((current) => {
      const exists = current.some((item) => item.source === document.source && item.path === document.path);
      const next = exists
        ? current.filter((item) => item.source !== document.source || item.path !== document.path)
        : [{ source: document.source, sourceName: document.sourceName, path: document.path, title: document.title, openedAt: Date.now() }, ...current].slice(0, 30);
      if (storageKeys) persist(storageKeys.favorites, next);
      return next;
    });
  };

  const copyLink = async () => {
    await navigator.clipboard.writeText(window.location.href);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  const openBacklink = async (link: Backlink) => {
    await resolveWiki(`${link.source}:${link.slug}`);
  };

  const breadcrumbs = folder ? folder.split('/').filter(Boolean) : [];
  const pageTitle = document?.title || binary?.name || (folder ? folder.split('/').pop() : selectedSource?.name) || 'Портал знаний';

  return (
    <div className="portal-shell">
      <header className="topbar">
        <button className="icon-button mobile-only" onClick={() => setExplorerOpen(true)} aria-label="Открыть проводник"><Icon name="menu" /></button>
        <a className="brand" href="/portal" onClick={(event) => { event.preventDefault(); if (sourceId) void loadFolder(sourceId, '', true); }}>
          <span className="brand-mark">G</span>
          <span><strong>GBrain</strong><small>Портал знаний</small></span>
        </a>
        <button ref={searchTriggerRef} className="global-search" onClick={() => setSearchOpen(true)}>
          <Icon name="search" />
          <span>Найти документ или раздел</span>
          <kbd>Ctrl K</kbd>
        </button>
        <div className="topbar-actions">
          {session?.isAdmin && <a className="quiet-link" href="/admin/">Администрирование</a>}
          <span className="read-only-badge">Только чтение</span>
          <button className="quiet-link logout-link" onClick={() => void portalApi.logout().finally(() => window.location.assign('/login'))}>Выйти</button>
          <button className="icon-button mobile-only" onClick={() => setContextOpen(true)} aria-label="Открыть контекст"><Icon name="panel" /></button>
        </div>
      </header>

      <aside className={`explorer ${explorerOpen ? 'drawer-open' : ''}`} aria-label="Проводник по базе знаний" aria-hidden={mobile && !explorerOpen} inert={mobile && !explorerOpen ? true : undefined}>
        <div className="panel-mobile-head mobile-only"><strong>Проводник</strong><button className="icon-button" onClick={() => setExplorerOpen(false)} aria-label="Закрыть"><Icon name="close" /></button></div>
        <div className="source-control">
          <label htmlFor="source-select">Источник знаний</label>
          <select id="source-select" value={sourceId} onChange={(event) => chooseSource(event.target.value)} disabled={!sources.length}>
            {!sources.length && <option value="">Нет доступных источников</option>}
            {sources.map((source) => <option key={source.id} value={source.id}>{source.name || source.id}</option>)}
          </select>
          {selectedSource && <span className="source-id">{selectedSource.id}</span>}
          {selectedSource && <span className="source-summary">Разделы: {sourceSummary.complete ? '' : '≥'}{sourceSummary.sections} · Документы: {sourceSummary.complete ? '' : '≥'}{sourceSummary.documents}</span>}
        </div>

        <nav className="folder-breadcrumbs" aria-label="Путь к папке">
          <button onClick={() => void loadFolder(sourceId, '', true)} className={!folder ? 'active' : ''}>Корень</button>
          {breadcrumbs.map((part, index) => {
            const path = breadcrumbs.slice(0, index + 1).join('/');
            return <span key={path}><Icon name="chevron" size={14} /><button onClick={() => void loadFolder(sourceId, path, true)} className={index === breadcrumbs.length - 1 ? 'active' : ''}>{part}</button></span>;
          })}
        </nav>

        <div className="tree-heading"><span>{folder ? 'Содержимое папки' : 'Разделы и документы'}</span><span>{treeSummary.complete ? '' : '≥'}{treeSummary.sections} разд. · {treeSummary.complete ? '' : '≥'}{treeSummary.documents} док.</span></div>
        <div className="tree-list" role="tree" aria-busy={loadingTree}>
          {folder && <button className="tree-row parent-row" onClick={() => void loadFolder(sourceId, parentPath(folder), true)}><Icon name="back" /><span>На уровень выше</span></button>}
          {loadingTree && <div className="skeleton-list">{[1, 2, 3, 4, 5].map((item) => <span key={item} />)}</div>}
          {!loadingTree && entries.map((entry) => {
            const active = document?.path === entry.path || binary?.path === entry.path;
            return <button key={entry.path} role="treeitem" aria-selected={active} className={`tree-row ${active ? 'active' : ''}`} onClick={() => chooseEntry(entry)} title={entry.path}>
              <span className={`file-icon ${fileKind(entry)}`}><Icon name={fileKind(entry)} /></span>
              <span className="tree-row-label"><strong>{entry.name}</strong>{entry.type === 'file' && <small>{humanBytes(entry.size)}</small>}</span>
              {entry.type === 'dir' && <><span className="tree-count" aria-label={`${entry.documentCount || 0} документов`}>{entry.documentCount || 0}</span><Icon name="chevron" size={15} /></>}
            </button>;
          })}
          {!loadingTree && !entries.length && !error && <div className="empty-compact">В этой папке пока ничего нет</div>}
        </div>

        {(favorites.length > 0 || recents.length > 0) && <div className="saved-block">
          {favorites.length > 0 && <><h3>Избранное</h3>{favorites.slice(0, 4).map((item) => <button key={`${item.source}:${item.path}`} onClick={() => void openDocument(item.source, item.path, true)}><Icon name="star" size={15} /><span>{item.title}</span></button>)}</>}
          {recents.length > 0 && <><h3>Недавние</h3>{recents.slice(0, 4).map((item) => <button key={`${item.source}:${item.path}`} onClick={() => void openDocument(item.source, item.path, true)}><Icon name="doc" size={15} /><span>{item.title}</span></button>)}</>}
        </div>}
      </aside>

      <main className="workspace">
        <div className="document-toolbar">
          <div className="document-location">
            <span>{selectedSource?.name || 'GBrain'}</span>
            {document?.path && <><Icon name="chevron" size={13} /><span>{document.path}</span></>}
            {binary?.path && <><Icon name="chevron" size={13} /><span>{binary.path}</span></>}
          </div>
          <div className="document-actions">
            {document && <button className={`toolbar-button ${isFavorite ? 'selected' : ''}`} onClick={toggleFavorite}><Icon name="star" /> <span>{isFavorite ? 'В избранном' : 'В избранное'}</span></button>}
            {(document || binary) && <button className="toolbar-button" onClick={() => void copyLink()}><Icon name="copy" /> <span>{copied ? 'Скопировано' : 'Ссылка'}</span></button>}
            {(document || binary) && <a className="toolbar-button" href={portalApi.downloadUrl(sourceId, (document || binary)!.path)}><Icon name="download" /> <span>Скачать</span></a>}
          </div>
        </div>

        {error && <div className="error-banner" role="alert"><span>{error}</span><button onClick={() => setError('')} aria-label="Закрыть"><Icon name="close" size={16} /></button></div>}

        <article className="document-scroll" ref={articleRef} onClick={onArticleClick}>
          {loadingDocument && <div className="document-skeleton"><span /><span /><span /><span /><span /></div>}
          {!loadingDocument && document && <div className="document-card">
            <header className="document-header">
              <div className="eyebrow">{document.type || 'Документ'}{document.status ? ` · ${document.status}` : ''}</div>
              <h1>{document.title || fallbackTitle(document.path)}</h1>
              <div className="document-meta"><span>{document.sourceName}</span><span>{humanBytes(document.size)}</span><span>Обновлено {new Date(document.updatedAt).toLocaleDateString('ru-RU')}</span></div>
              {document.tags.length > 0 && <div className="tag-list">{document.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>}
            </header>
            <div className="markdown-body" dangerouslySetInnerHTML={{ __html: rendered.html }} />
          </div>}

          {!loadingDocument && binary && <div className="empty-state binary-state">
            <span className="empty-icon"><Icon name={fileKind(binary)} size={32} /></span>
            <h1>{binary.name}</h1>
            <p>Предпросмотр этого типа файла пока не поддерживается. Файл можно безопасно скачать.</p>
            <a className="primary-button" href={portalApi.downloadUrl(sourceId, binary.path)}><Icon name="download" /> Скачать {binary.size ? `· ${humanBytes(binary.size)}` : ''}</a>
          </div>}

          {!loadingDocument && !document && !binary && <div className="welcome-state">
            <div className="welcome-copy"><span className="eyebrow">Корпоративная база знаний</span><h1>{pageTitle}</h1><p>Выберите раздел слева или найдите документ по названию и содержанию.</p><button className="primary-button" onClick={() => setSearchOpen(true)}><Icon name="search" /> Начать поиск</button></div>
            <div className="welcome-grid"><div><strong>Быстрая навигация</strong><span>Источники и папки собраны в одном проводнике.</span></div><div><strong>Связанные знания</strong><span>Переходите по wikilinks и обратным ссылкам.</span></div><div><strong>Безопасный доступ</strong><span>Показываются только разрешённые вам источники.</span></div></div>
          </div>}
        </article>
      </main>

      <aside className={`context-panel ${contextOpen ? 'drawer-open' : ''}`} aria-label="Контекст документа" aria-hidden={mobile && !contextOpen} inert={mobile && !contextOpen ? true : undefined}>
        <div className="panel-mobile-head mobile-only"><strong>Контекст</strong><button className="icon-button" onClick={() => setContextOpen(false)} aria-label="Закрыть"><Icon name="close" /></button></div>
        {document ? <>
          <section><h2>На этой странице</h2>{rendered.outline.length ? <nav className="outline">{rendered.outline.map((item) => <button key={item.id} className={`level-${item.level}`} onClick={() => window.document.getElementById(item.id)?.scrollIntoView({ behavior: 'smooth' })}>{item.text}</button>)}</nav> : <p className="context-muted">В документе нет заголовков.</p>}</section>
          <section><h2>О документе</h2><dl className="metadata-list"><div><dt>Источник</dt><dd>{document.sourceName}</dd></div><div><dt>Путь</dt><dd title={document.path}>{document.path}</dd></div>{document.slug && <div><dt>Slug</dt><dd>{document.slug}</dd></div>}<div><dt>Размер</dt><dd>{humanBytes(document.size)}</dd></div></dl></section>
          <section><h2>Обратные ссылки <span className="section-count">{context?.backlinks.length || 0}</span></h2>{context?.backlinks.length ? <div className="backlink-list">{context.backlinks.slice(0, 12).map((link) => <button key={`${link.source}:${link.slug}:${link.type}`} onClick={() => void openBacklink(link)}><span>{link.title || link.slug}</span><small>{link.source} · {link.type}</small></button>)}</div> : <p className="context-muted">Другие страницы пока не ссылаются на этот документ.</p>}</section>
        </> : <div className="context-placeholder"><Icon name="panel" size={28} /><p>Откройте документ, чтобы увидеть оглавление, метаданные и связи.</p></div>}
      </aside>

      {(explorerOpen || contextOpen) && <button className="drawer-backdrop mobile-only" onClick={() => { setExplorerOpen(false); setContextOpen(false); }} aria-label="Закрыть панель" />}

      {searchOpen && <div className="search-overlay" role="dialog" aria-modal="true" aria-label="Поиск по базе знаний" onMouseDown={(event) => { if (event.target === event.currentTarget) setSearchOpen(false); }}>
        <div className="search-dialog" ref={searchDialogRef} onKeyDown={trapSearchFocus}>
          <div className="search-input-wrap"><Icon name="search" size={22} /><input ref={searchRef} value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} onKeyDown={onSearchKeyDown} placeholder="Название, путь или фрагмент текста…" aria-label="Поисковый запрос" aria-activedescendant={searchResults.length ? `portal-search-result-${activeSearchIndex}` : undefined} /><kbd>Esc</kbd></div>
          <div className="search-content" role="listbox" aria-label="Результаты поиска">
            {searchLoading && <div className="search-status">Ищем в доступных источниках…</div>}
            {!searchLoading && searchQuery.trim().length < 2 && <div className="search-hint"><strong>Глобальный поиск</strong><span>Введите минимум два символа. Поиск ограничен источниками, к которым у вас есть доступ.</span></div>}
            {!searchLoading && searchQuery.trim().length >= 2 && !searchResults.length && <div className="search-status">Ничего не найдено</div>}
            {!searchLoading && searchResults.map((result, index) => <button role="option" aria-selected={index === activeSearchIndex} id={`portal-search-result-${index}`} className={`search-result ${index === activeSearchIndex ? 'active' : ''}`} key={`${result.source}:${result.path}`} onMouseEnter={() => setActiveSearchIndex(index)} onClick={() => chooseSearchResult(result)}>
              <span className="search-result-icon"><Icon name={result.markdown ? 'doc' : 'file'} /></span>
              <span className="search-result-copy"><strong>{result.title || result.name}</strong><small>{result.sourceName || result.source} / {result.path}</small>{result.snippet && <p>{result.snippet}</p>}</span>
              <span className="search-match">{{ title: 'Название', path: 'Путь', heading: 'Раздел', content: 'Содержание', name: 'Имя файла' }[result.match]}</span>
            </button>)}
          </div>
          <footer className="search-footer"><span><kbd>↑</kbd><kbd>↓</kbd> выбрать</span><span><kbd>Enter</kbd> открыть</span><span>{searchResults.length ? `${searchResults.length} результатов` : ''}</span></footer>
        </div>
      </div>}
    </div>
  );
}
