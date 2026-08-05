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
import { MeetingReviewPage } from './pages/MeetingReview';
import { ReviewRoundsPage } from './pages/ReviewRounds';
import { AccessControlPage } from './pages/AccessControl';
import { api } from './api';

type Page = 'login' | 'dashboard' | 'agents' | 'log' | 'calibration' | 'ai-review' | 'concept-review' | 'meeting-review' | 'review-rounds' | 'jobs' | 'activity' | 'source-ingest' | 'access-control';

const NAV_ITEMS: Array<{ page: Exclude<Page, 'login'>; label: string; icon: string }> = [
  { page: 'dashboard', label: 'Обзор', icon: '▣' },
  { page: 'agents', label: 'Агенты', icon: '◉' },
  { page: 'log', label: 'Журнал запросов', icon: '≋' },
  { page: 'calibration', label: 'Калибровка', icon: '◌' },
  { page: 'ai-review', label: 'Проверка AI', icon: '✓' },
  { page: 'concept-review', label: 'Проверка концепций', icon: '◇' },
  { page: 'meeting-review', label: 'Проверка встреч', icon: '◫' },
  { page: 'review-rounds', label: 'Коллективная проверка', icon: '⚖' },
  { page: 'jobs', label: 'Задания', icon: '⚙' },
  { page: 'activity', label: 'Активность', icon: '◫' },
  { page: 'access-control', label: 'Доступы', icon: '⌁' },
  { page: 'source-ingest', label: 'Импорт данных', icon: '⇄' },
];

function getPage(): Page {
  const hash = window.location.hash.replace(/^#/, '') || 'dashboard';
  const topLevel = hash.split('/')[0];
  if (['login', 'dashboard', 'agents', 'log', 'calibration', 'ai-review', 'concept-review', 'meeting-review', 'review-rounds', 'jobs', 'activity', 'source-ingest', 'access-control'].includes(topLevel)) return topLevel as Page;
  return 'dashboard';
}

async function submitPortalLogout(): Promise<string | null> {
  const response = await fetch('/logout', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok && response.status !== 401) throw new Error(`HTTP ${response.status}`);
  if (response.status === 204) return null;
  const body = await response.json().catch(() => ({})) as { logout_url?: unknown };
  return typeof body.logout_url === 'string' ? body.logout_url : null;
}

export function App() {
  const [page, setPage] = useState<Page>(getPage);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem('gbrain-admin-sidebar-collapsed') === '1');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [pendingReviewCount, setPendingReviewCount] = useState<number | null>(null);
  const [pendingConceptCount, setPendingConceptCount] = useState<number | null>(null);
  const [pendingMeetingCount, setPendingMeetingCount] = useState<number | null>(null);

  useEffect(() => {
    const onHash = () => {
      setPage(getPage());
      setMobileNavOpen(false);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    const syncPendingCount = (event: Event) => {
      const count = Number((event as CustomEvent<number>).detail);
      if (Number.isFinite(count)) setPendingReviewCount(count);
    };
    window.addEventListener('gbrain:ai-review-pending-count', syncPendingCount);
    return () => window.removeEventListener('gbrain:ai-review-pending-count', syncPendingCount);
  }, []);

  useEffect(() => {
    const syncPendingCount = (event: Event) => {
      const count = Number((event as CustomEvent<number>).detail);
      if (Number.isFinite(count)) setPendingConceptCount(count);
    };
    window.addEventListener('gbrain:concept-review-pending-count', syncPendingCount);
    return () => window.removeEventListener('gbrain:concept-review-pending-count', syncPendingCount);
  }, []);

  useEffect(() => {
    localStorage.setItem('gbrain-admin-sidebar-collapsed', sidebarCollapsed ? '1' : '0');
  }, [sidebarCollapsed]);

  useEffect(() => {
    let alive = true;
    const refreshCount = () => {
      void api.aiReviewProposals({ status: 'pending', limit: 1 })
        .then(data => { if (alive) setPendingReviewCount(Number(data.total ?? 0)); })
        .catch(() => { if (alive) setPendingReviewCount(null); });
      void api.aiReviewConcepts({ status: 'pending', limit: 1 })
        .then(data => { if (alive) setPendingConceptCount(Number(data.total ?? 0)); })
        .catch(() => { if (alive) setPendingConceptCount(null); });
      void api.meetingReviewItems({ status: 'pending', review_class: 'exception', limit: 1 })
        .then(data => { if (alive) setPendingMeetingCount(Number(data.total ?? 0)); })
        .catch(() => { if (alive) setPendingMeetingCount(null); });
    };
    refreshCount();
    const timer = window.setInterval(refreshCount, 15_000);
    window.addEventListener('focus', refreshCount);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', refreshCount);
    };
  }, []);

  const navigate = (p: Page) => {
    window.location.hash = p;
    setPage(p);
    setMobileNavOpen(false);
  };

  if (page === 'login') {
    return <LoginPage onLogin={() => navigate('dashboard')} />;
  }

  const handleSignOutEverywhere = async () => {
    if (!confirm('Завершить все активные админ-сессии, включая другие браузеры и вкладки? Для повторного входа потребуется новая ссылка.')) {
      return;
    }
    try {
      await api.signOutEverywhere().catch(() => undefined);
    } finally {
      const logoutUrl = await submitPortalLogout().catch(() => null);
      window.location.assign(logoutUrl || '/login');
    }
  };

  return (
    <div className={`app ${sidebarCollapsed ? 'sidebar-collapsed' : ''} ${mobileNavOpen ? 'mobile-nav-open' : ''}`}>
      <button
        className="mobile-nav-toggle"
        type="button"
        onClick={() => setMobileNavOpen(open => !open)}
        aria-expanded={mobileNavOpen}
        aria-controls="admin-sidebar"
        aria-label={mobileNavOpen ? 'Закрыть меню' : 'Открыть меню'}
      >
        {mobileNavOpen ? '×' : '☰'}
      </button>
      {mobileNavOpen && <button className="mobile-nav-backdrop" type="button" aria-label="Закрыть меню" onClick={() => setMobileNavOpen(false)} />}
      <nav id="admin-sidebar" className="sidebar" aria-label="Навигация администратора">
        <div className="sidebar-topbar">
          <div className="sidebar-logo" title="GBrain">{sidebarCollapsed ? 'GB' : 'GBrain'}</div>
          <button
            className="sidebar-toggle"
            type="button"
            onClick={() => setSidebarCollapsed(v => !v)}
            aria-label={sidebarCollapsed ? 'Развернуть меню' : 'Свернуть меню'}
            title={sidebarCollapsed ? 'Развернуть меню' : 'Свернуть меню'}
          >
            {sidebarCollapsed ? '›' : '‹'}
          </button>
        </div>
        <div className="sidebar-nav">
          {NAV_ITEMS.map(item => <button
            key={item.page}
            type="button"
            className={`nav-item ${page === item.page ? 'active' : ''}`}
            onClick={() => navigate(item.page)}
            aria-current={page === item.page ? 'page' : undefined}
            title={item.label}
          >
            <span className="nav-icon" aria-hidden="true">{item.icon}</span>
            <span className="nav-label">{item.label}</span>
            {item.page === 'ai-review' && pendingReviewCount !== null && pendingReviewCount > 0 && (
              <span className="nav-badge" aria-label={`${pendingReviewCount} ожидают проверки`}>{pendingReviewCount}</span>
            )}
            {item.page === 'concept-review' && pendingConceptCount !== null && pendingConceptCount > 0 && (
              <span className="nav-badge" aria-label={`${pendingConceptCount} концепций ожидают проверки`}>{pendingConceptCount}</span>
            )}
            {item.page === 'meeting-review' && pendingMeetingCount !== null && pendingMeetingCount > 0 && (
              <span className="nav-badge" aria-label={`${pendingMeetingCount} встреч ожидают проверки`}>{pendingMeetingCount}</span>
            )}
          </button>)}
        </div>
        <div className="sidebar-footer">
          <button
            onClick={handleSignOutEverywhere}
            className="sidebar-signout"
            title="Завершить все активные админ-сессии"
          >
            <span className="nav-icon" aria-hidden="true">⎋</span>
            <span className="nav-label">Выйти везде</span>
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
        {page === 'meeting-review' && <MeetingReviewPage />}
        {page === 'review-rounds' && <ReviewRoundsPage />}
        {page === 'jobs' && <JobsWatchPage />}
        {page === 'activity' && <ActivityPage />}
        {page === 'access-control' && <AccessControlPage />}
        {page === 'source-ingest' && <SourceIngestPage />}
      </main>
    </div>
  );
}
