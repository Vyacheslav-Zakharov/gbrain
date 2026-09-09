export interface PortalSource {
  id: string;
  name: string;
}

export interface PortalSession {
  email: string;
  isAdmin: boolean;
  readOnly: true;
  /**
   * Server-derived capability flag. It only decides whether the reviewer
   * entry point renders; every review endpoint re-checks identity and ACL.
   */
  canReview?: boolean;
}

export interface TreeEntry {
  name: string;
  path: string;
  type: 'dir' | 'file';
  markdown: boolean;
  size: number;
  updatedAt?: string;
  documentCount?: number;
}

export interface TreeSummary {
  sections: number;
  documents: number;
  complete: boolean;
}

export interface TreeResponse {
  source: string;
  path: string;
  entries: TreeEntry[];
  summary: TreeSummary;
  sourceSummary: TreeSummary;
}

export interface FileResponse {
  source: string;
  sourceName: string;
  path: string;
  name: string;
  content: string;
  size: number;
  updatedAt: string;
  slug: string;
  title: string;
  type?: string;
  status?: string;
  tags: string[];
}

export interface SearchResult {
  source: string;
  sourceName: string;
  name: string;
  path: string;
  markdown: boolean;
  size: number;
  match: 'title' | 'path' | 'heading' | 'content' | 'name';
  title?: string;
  snippet?: string;
  score?: number;
}

export interface Backlink {
  source: string;
  slug: string;
  title: string;
  type: string;
  context?: string;
}

export interface ContextResponse {
  source: string;
  slug: string;
  backlinks: Backlink[];
  /** ACL-filtered meeting relations: canonical attendance and explicit mentions. */
  meetings?: Backlink[];
}

export interface RecentDocument {
  source: string;
  sourceName: string;
  path: string;
  title: string;
  openedAt: number;
}
