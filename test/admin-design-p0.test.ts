import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mergeEvents } from '../admin/src/event-merge';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('Admin design P0 contracts', () => {
  test('Dashboard replaces an SSE event with its persisted request-log row', () => {
    const sse = { agent: 'agent-a', operation: 'tools/list', scopes: 'read', latency_ms: 12, status: 'success', timestamp: '2026-07-30T06:00:01.000Z' };
    const persisted = { ...sse, id: 42, scopes: '', timestamp: '2026-07-30T06:00:02.000Z' };
    expect(mergeEvents([sse], [persisted])).toEqual([persisted]);
  });

  test('navigation is Russian and surfaces pending AI and concept review counts', () => {
    const app = read('admin/src/App.tsx');
    const css = read('admin/src/index.css');
    expect(app).toContain("label: 'Проверка AI'");
    expect(app).toContain("label: 'Импорт данных'");
    expect(app).toContain('nav-badge');
    expect(app).toContain("status: 'pending', limit: 1");
    expect(app).toContain('pendingConceptCount');
    expect(app).toContain("api.aiReviewConcepts({ status: 'pending', limit: 1 })");
    expect(app).toContain('gbrain:concept-review-pending-count');
    expect(app).toContain('mobile-nav-toggle');
    expect(app).toContain('aria-controls="admin-sidebar"');
    expect(css).toContain('.app.mobile-nav-open .sidebar');
  });

  test('Concept Review reuses accessible AI Review visual hierarchy', () => {
    const page = read('admin/src/pages/ConceptReview.tsx');
    expect(page).toContain('className="ai-review"');
    expect(page).toContain('className="ai-review-header"');
    expect(page).toContain('className="ai-review-count"');
    expect(page).toContain('className={`proposal-row');
    expect(page).toContain('className="reject"');
    expect(page).toContain('className="accept"');
    expect(page).toContain('Ожидают проверки:');
    expect(page).toContain('Есть русский черновик');
  });

  test('admin API fails bounded requests instead of loading forever', () => {
    const api = read('admin/src/api.ts');
    expect(api).toContain('ADMIN_REQUEST_TIMEOUT_MS');
    expect(api).toContain('AbortController');
    expect(api).toContain('Превышено время ожидания ответа');
  });

  test('AI Review has source filter and local action errors', () => {
    const page = read('admin/src/pages/AIReview.tsx');
    const css = read('admin/src/pages/AIReview.css');
    expect(page).toContain('source_id: sourceFilter');
    expect(page).toContain('setActionError');
    expect(page).toContain('ai-review-inline-error');
    expect(page).toContain('Фильтр по источнику');
    expect(page).not.toContain('<h1>AI Review</h1>');
    expect(css).toContain('grid-template-columns:repeat(2,minmax(0,1fr))');
    expect(css).toContain('.proposal-row-top,.proposal-row-meta{color:#c3c9d4');
    expect(page).toContain('useState<number | null>(null)');
    expect(page).toContain('gbrain:ai-review-pending-count');
    expect(page).toContain('const listRequest = useRef(0)');
    expect(page).toContain('request !== listRequest.current');
    for (const label of ['>Тип<', '>Владелец<', '>Вес уверенности<', '>Область<', '>Действует с<', '>Дополнительный источник<']) {
      expect(page).toContain(label);
    }
    expect(page).not.toContain('Тип (kind)');
  });

  test('loading screens provide progress semantics and retryable Russian errors', () => {
    const calibration = read('admin/src/pages/Calibration.tsx');
    const jobs = read('admin/src/pages/JobsWatch.tsx');
    expect(calibration).toContain('aria-busy="true"');
    expect(calibration).toContain('Повторить');
    expect(jobs).toContain('aria-busy="true"');
    expect(jobs).toContain('Повторить');
  });

  test('Agents empty state includes actions', () => {
    const agents = read('admin/src/pages/Agents.tsx');
    expect(agents).toContain('empty-state-actions');
    expect(agents).toContain('Создать OAuth-клиент');
    expect(agents).toContain('Создать API-ключ');
    expect(agents).toContain('agentShortId');
  });

  test('Dashboard live activity has SSE heartbeat support and request-log fallback', () => {
    const dashboard = read('admin/src/pages/Dashboard.tsx');
    const merge = read('admin/src/event-merge.ts');
    const server = read('src/commands/serve-http.ts');
    expect(dashboard).toContain("new EventSource('/admin/events', { withCredentials: true })");
    expect(dashboard).toContain('api.requests(1)');
    expect(merge).toContain('matchedPersistedIds');
    expect(merge).toContain('candidate.latency_ms === event.latency_ms');
    expect(dashboard).not.toContain('Reconnect handled by browser EventSource auto-retry');
    expect(server).toContain("res.setHeader('X-Accel-Buffering', 'no')");
    expect(server).toContain("res.write('retry: 3000\\n: connected\\n\\n')");
    expect(server).toContain("res.write(': heartbeat\\n\\n')");
  });

  test('Activity metrics and title are consistently Russian', () => {
    const activity = read('admin/src/pages/Activity.tsx');
    expect(activity).toContain('>Активность<');
    for (const label of ['Запуски', 'Частичные', 'Атомы', 'Концепции', 'Предложения', 'Тезисы', 'Расход LLM']) {
      expect(activity).toContain(`label="${label}"`);
    }
    expect(activity).not.toContain('Activity / Runs');
    for (const untranslated of ['Все sources', 'Все типы jobs', 'Нет phase reports', ' warn/skip/fail', ' runs из']) {
      expect(activity).not.toContain(untranslated);
    }
    expect(activity).toContain('STATUS_LABELS');
  });

  test('Calibration empty state submits a durable GUI job', () => {
    const calibration = read('admin/src/pages/Calibration.tsx');
    const api = read('admin/src/api.ts');
    const server = read('src/commands/serve-http.ts');
    expect(calibration).toContain('Создать профиль калибровки');
    expect(calibration).toContain('api.startCalibration()');
    expect(calibration).not.toContain('gbrain dream --phase calibration_profile');
    expect(api).toContain("startCalibration: () => apiFetch('/admin/api/calibration/run'");
    expect(server).toContain("app.post('/admin/api/calibration/run', requireAdmin, requireAdminSameOrigin");
    expect(server).toContain("argv: [process.execPath, cliEntry, 'dream', '--phase', 'calibration_profile']");
    expect(server).toContain("'calibration_profile'");
    expect(server).toContain('admin-calibration-profile:retry:');
    expect(calibration).toContain("result.status === 'completed'");
  });
});
