/** Path the reviewer deck is served from. Kept in one place so the server route, the nav link, and the SPA switch cannot drift. */
export const REVIEW_ROUTE = '/portal/review';

export function isReviewRoute(pathname: string): boolean {
  const clean = String(pathname || '').replace(/\/+$/, '');
  return clean === REVIEW_ROUTE;
}
