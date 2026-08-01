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
import { ReviewRoundsPage } from './pages/ReviewRounds';
import { api } from './api';

type Page = 'login' | 'dashboard' | 'agents' | 'log' | 'calibration' | 'ai-review' | 'concept-review' | 'review-rounds' | 'jobs' | 'activity' | 'source-ingest';

const NAV_ITEMS: Array<{ page: Exclude<Page, 'login'>; label: string; icon: string }> = [
  { page: 'dashboard', label: 'Обзор', icon: '▣' },
  { page: 'agents', label: 'Агенты', icon: '◉' },
  { page: 'log', label: 'Журнал запросов', icon: '≋' },
  { page: 'calibration', label: 'Калибровка', icon: '◌' },
  { page: 'ai-review', label: 'Проверка AI', icon: '✓' },
  { page: 'concept-review', label: 'Проверка концепций', icon: '◇' },
  { page: 'review-rounds', label: 'Коллективная проверка', icon: '⚖' },
  { page: 'jobs', label: 'Задания', icon: '⚙' },
  { page: 'activity', label: 'Активность', icon: '◫' },
  { page: 'source-ingest', label: 'Импорт данных', icon: '⇄' },
];

function getPage(): Page {
  const hash = window.location.hash.replace(/^#/, '') || 'dashboard';
  const topLevel = hash.split('/')[0];
  if (['login', 'dashboard', 'agents', 'log', 'calibration', 'ai-review', 'concept-review', 'review-rounds', 'jobs', 'activity', 'source-ingest'].includes(topLevel)) return topLevel as Page;
  return 'dashboard';
}

export function App() {
  const [page, setPage] = useState<Page>(getPage);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem('gbrain-admin-sidebar-collapsed') === '1');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [pendingReviewCount, setPendingReviewCount] = useState<number | null>(null);

  useEffect(() => {
    const onHash = () => {
      setPage(getPage());
      setMobileNavOpen(false);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
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
    };
    refreshCount();
    const timer = window.setInterval(refreshCount, 60_000);
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
      await api.signOutEverywhere();
    } catch {
      // Even if the call fails, push to login — cookie is likely already invalid.
    }
    navigate('login');
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
          {NAV_ITEMS.map(item => <a
            key={item.page}
            className={`nav-item ${page === item.page ? 'active' : ''}`}
            onClick={() => navigate(item.page)}
            title={item.label}
          >
            <span className="nav-icon" aria-hidden="true">{item.icon}</span>
            <span className="nav-label">{item.label}</span>
            {item.page === 'ai-review' && pendingReviewCount !== null && pendingReviewCount > 0 && (
              <span className="nav-badge" aria-label={`${pendingReviewCount} ожидают проверки`}>{pendingReviewCount}</span>
            )}
          </a>)}
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
        {page === 'review-rounds' && <ReviewRoundsPage />}
        {page === 'jobs' && <JobsWatchPage />}
        {page === 'activity' && <ActivityPage />}
        {page === 'source-ingest' && <SourceIngestPage />}
      </main>
    </div>
  );
}
