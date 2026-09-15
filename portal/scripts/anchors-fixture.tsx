import { createRoot } from 'react-dom/client';
import { PortalApp } from '../src/PortalApp';
import { renderMarkdown } from '../src/markdown';
import '../src/styles.css';
import { resolveArticleAnchor } from '../src/anchors';
Object.assign(window, { resolveArticleAnchor, markdown: { renderMarkdown }, mountPortal: () => createRoot(document.getElementById('article')!).render(<PortalApp />) });
