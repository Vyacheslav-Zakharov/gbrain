// A page-lifetime fence: simultaneous failed reads must not compete to navigate.
let redirectStarted = false;
const READING_POSITION_KEY = 'gbrain.portal.authReadingPosition';
const MAX_POSITION_AGE_MS = 30 * 60 * 1000;
type ReadingPosition = { href: string; top: number; left: number; savedAt: number };
let readingPosition: ReadingPosition | null = null;

function currentHref(): string {
  const { pathname, search, hash } = window.location;
  return pathname + search + hash;
}

export function portalLoginHref(): string {
  return `/login?return_to=${encodeURIComponent(currentHref())}`;
}

// Capture before a loading skeleton can collapse the scroll container.
export function rememberPortalReadingPosition(): void {
  const article = window.document.querySelector<HTMLElement>('.document-scroll');
  if (article) readingPosition = { href: currentHref(), top: article.scrollTop, left: article.scrollLeft, savedAt: Date.now() };
}

export function savePortalReadingPosition(): void {
  try {
    if (readingPosition?.href !== currentHref()) rememberPortalReadingPosition();
    if (readingPosition) window.sessionStorage.setItem(READING_POSITION_KEY, JSON.stringify({ ...readingPosition, savedAt: Date.now() }));
  } catch { /* Storage is optional; it must never block authentication. */ }
}

// Called after React has committed the loaded document, never on its skeleton.
export function restorePortalReadingPosition(article: HTMLElement): boolean {
  try {
    const raw = window.sessionStorage.getItem(READING_POSITION_KEY);
    if (!raw) return false;
    window.sessionStorage.removeItem(READING_POSITION_KEY);
    const position = JSON.parse(raw) as ReadingPosition;
    const age = Date.now() - position.savedAt;
    if (position.href !== currentHref() || !Number.isFinite(age) || age < 0 || age > MAX_POSITION_AGE_MS
      || !Number.isFinite(position.top) || position.top < 0 || !Number.isFinite(position.left) || position.left < 0) return false;
    article.scrollTop = position.top;
    article.scrollLeft = position.left;
    return true;
  } catch { return false; }
}

export function redirectToPortalLogin(): void {
  if (redirectStarted) return;
  redirectStarted = true;
  savePortalReadingPosition();
  window.location.assign(portalLoginHref());
}
