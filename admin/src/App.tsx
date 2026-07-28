import React, { useState, useEffect } from 'react';
import { LoginPage } from './pages/Login';
import { DashboardPage } from './pages/Dashboard';
import { AgentsPage } from './pages/Agents';
import { RequestLogPage } from './pages/RequestLog';
import { CalibrationPage } from './pages/Calibration';
import { JobsWatchPage } from './pages/JobsWatch';
import { ActivityPage } from './pages/Activity';
import { SourceIngestPage } from './pages/SourceIngest';
import { AIReviewPage } from './pages/AIReview';
import { ConceptReviewPage } from './pages/ConceptReview';
import { api } from './api';

type Page = 'login' | 'dashboard' | 'agents' | 'log' | 'calibration' | 'ai-review' | 'concept-review' | 'jobs' | 'activity' | 'source-ingest';

const NAV_ITEMS: Array<{ page: Exclude<Page, 'login'>; label: string; icon: string }> = [
  { page: 'dashboard', label: 'Dashboard', icon: '▣' },
  { page: 'agents', label: 'Agents', icon: '◉' },
  { page: 'log', label: 'Request Log', icon: '≋' },
  { page: 'calibration', label: 'Calibration', icon: '◌' },
  { page: 'ai-review', label: 'AI Review', icon: '✓' },
  { page: 'concept-review', label: 'Concept Review', icon: '◇' },
  { page: 'jobs', label: 'Jobs Watch', icon: '⚙' },
  { page: 'activity', label: 'Activity', icon: '◫' },
  { page: 'source-ingest', label: 'Source Ingest', icon: '⇄' },
];

function getPage(): Page {
  const hash = window.location.hash.replace(/^#/, '') || 'dashboard';
  const topLevel = hash.split('/')[0];
  if (['login', 'dashboard', 'agents', 'log', 'calibration', 'ai-review', 'concept-review', 'jobs', 'activity', 'source-ingest'].includes(topLevel)) return topLevel as Page;
  return 'dashboard';
}

export function App() {
  const [page, setPage] = useState<Page>(getPage);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem('gbrain-admin-sidebar-collapsed') === '1');

  useEffect(() => {
    const onHash = () => setPage(getPage());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    localStorage.setItem('gbrain-admin-sidebar-collapsed', sidebarCollapsed ? '1' : '0');
  }, [sidebarCollapsed]);

  const navigate = (p: Page) => {
    window.location.hash = p;
    setPage(p);
  };

  if (page === 'login') {
    return <LoginPage onLogin={() => navigate('dashboard')} />;
  }

  const handleSignOutEverywhere = async () => {
    if (!confirm('Sign out every active admin session, including other browsers and tabs? Each one will need to re-authenticate via a fresh magic link.')) {
      return;
    }
    try {
      await api.signOutEverywhere();
    } catch {
      // Even if the call fails, push to login — cookie is likely already invalid.
    }
    navigate('login');
  };

  return (
    <div className={`app ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
      <nav className="sidebar" aria-label="Admin navigation">
        <div className="sidebar-topbar">
          <div className="sidebar-logo" title="GBrain">{sidebarCollapsed ? 'GB' : 'GBrain'}</div>
          <button
            className="sidebar-toggle"
            type="button"
            onClick={() => setSidebarCollapsed(v => !v)}
            aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {sidebarCollapsed ? '›' : '‹'}
          </button>
        </div>
        <div className="sidebar-nav">
          {NAV_ITEMS.map(item => <a
            key={item.page}
            className={`nav-item ${page === item.page ? 'active' : ''}`}
            onClick={() => navigate(item.page)}
            title={item.label}
          >
            <span className="nav-icon" aria-hidden="true">{item.icon}</span>
            <span className="nav-label">{item.label}</span>
          </a>)}
        </div>
        <div className="sidebar-footer">
          <button
            onClick={handleSignOutEverywhere}
            className="sidebar-signout"
            title="Revoke every active admin session — every browser, every tab"
          >
            <span className="nav-icon" aria-hidden="true">⎋</span>
            <span className="nav-label">Sign out everywhere</span>
          </button>
        </div>
      </nav>
      <main className="main">
        {page === 'dashboard' && <DashboardPage />}
        {page === 'agents' && <AgentsPage />}
        {page === 'log' && <RequestLogPage />}
        {page === 'calibration' && <CalibrationPage />}
        {page === 'ai-review' && <AIReviewPage />}
        {page === 'concept-review' && <ConceptReviewPage />}
        {page === 'jobs' && <JobsWatchPage />}
        {page === 'activity' && <ActivityPage />}
        {page === 'source-ingest' && <SourceIngestPage />}
      </main>
    </div>
  );
}
