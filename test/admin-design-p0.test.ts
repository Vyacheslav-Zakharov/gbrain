import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { describeFeedError, feedEventKey, formatSafeParams, mergeEvents } from '../admin/src/event-merge';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('Admin design P0 contracts', () => {
  test('Dashboard replaces an SSE event with its persisted row without collapsing open details', () => {
    const sse = { agent: 'agent-a', operation: 'tools/list', scopes: 'read', latency_ms: 12, status: 'success', timestamp: '2026-07-30T06:00:01.000Z' };
    const persisted = { ...sse, id: 42, scopes: '', timestamp: '2026-07-30T06:00:02.000Z' };
    const [merged] = mergeEvents([sse], [persisted]);
    expect(merged).toEqual({ ...persisted, ui_key: feedEventKey(sse) });
    expect(feedEventKey(merged)).toBe(feedEventKey(sse));
  });

  test('Dashboard preserves the unmatched provisional row during a partial poll', () => {
    const base = { agent: 'agent-a', operation: 'get_page', scopes: 'read', latency_ms: 8, status: 'error' };
    const sseA = { ...base, timestamp: '2026-08-06T03:46:18.000Z', ui_key: 'sse-a' };
    const sseB = { ...base, timestamp: '2026-08-06T03:46:18.500Z', ui_key: 'sse-b' };
    const persistedA = { ...base, id: 5601, scopes: '', timestamp: '2026-08-06T03:46:18.100Z' };

    const partialPoll = mergeEvents([sseB, sseA], [persistedA]);

    expect(partialPoll).toHaveLength(2);
    expect(new Set(partialPoll.map(feedEventKey))).toEqual(new Set(['sse-a', 'sse-b']));
    expect(partialPoll.find(event => event.id === 5601)?.ui_key).toBe('sse-a');
  });

  test('Dashboard keeps repeated similar SSE requests distinct across polling refreshes', () => {
    const base = { agent: 'agent-a', operation: 'get_page', scopes: 'read', latency_ms: 8, status: 'error' };
    const sseA = { ...base, timestamp: '2026-08-06T03:46:18.000Z', ui_key: 'sse-a' };
    const sseB = { ...base, timestamp: '2026-08-06T03:46:18.500Z', ui_key: 'sse-b' };
    const persistedA = { ...base, id: 5601, scopes: '', timestamp: '2026-08-06T03:46:18.100Z' };
    const persistedB = { ...base, id: 5602, scopes: '', timestamp: '2026-08-06T03:46:18.600Z' };

    const firstPoll = mergeEvents([sseB, sseA], [persistedB, persistedA]);
    const secondPoll = mergeEvents(firstPoll, [persistedB, persistedA]);

    expect(firstPoll).toHaveLength(2);
    expect(new Set(firstPoll.map(feedEventKey))).toEqual(new Set(['sse-a', 'sse-b']));
    expect(secondPoll).toHaveLength(2);
    expect(new Set(secondPoll.map(feedEventKey))).toEqual(new Set(['sse-a', 'sse-b']));
  });

  test('Dashboard does not collapse distinct SSE events from the same millisecond', () => {
    const base = {
      agent: 'agent-a', operation: 'get_page', scopes: 'read', latency_ms: 8, status: 'error',
      timestamp: '2026-08-06T03:46:18.000Z',
    };
    const events = mergeEvents([], [
      { ...base, ui_key: 'sse-a' },
      { ...base, ui_key: 'sse-b' },
    ]);

    expect(events).toHaveLength(2);
    expect(new Set(events.map(feedEventKey))).toEqual(new Set(['sse-a', 'sse-b']));
  });

  test('Dashboard keeps distinct persisted request IDs even when every display field matches', () => {
    const base = {
      agent: 'agent-a', operation: 'get_page', scopes: 'read', latency_ms: 8, status: 'error',
      timestamp: '2026-08-06T03:46:18.000Z',
    };
    const events = mergeEvents(
      [{ ...base, id: 5601 }],
      [{ ...base, id: 5602 }],
    );

    expect(events).toHaveLength(2);
    expect(events.map(event => event.id)).toEqual([5602, 5601]);
  });

  test('Dashboard does not let a historical persisted row consume a fresh SSE event', () => {
    const base = {
      agent: 'agent-a', operation: 'get_page', scopes: 'read', latency_ms: 8, status: 'error',
    };
    const oldPersisted = { ...base, id: 5601, timestamp: '2026-08-06T03:46:18.000Z' };
    const freshSse = { ...base, ui_key: 'sse-new', timestamp: '2026-08-06T03:46:19.000Z' };

    const events = mergeEvents([oldPersisted], [freshSse]);

    expect(events).toHaveLength(2);
    expect(new Set(events.map(feedEventKey))).toEqual(new Set(['request-5601', 'sse-new']));
  });

  test('Dashboard explains request errors in plain Russian and keeps params redacted', () => {
    const pageMissingEvent = {
      id: 5601,
      agent: 'agent-a',
      operation: 'get_page',
      scopes: '',
      latency_ms: 8,
      status: 'error',
      timestamp: '2026-08-06T03:46:18.000Z',
      error_message: 'Page not found: projects/example',
      params: { redacted: true, declared_keys: ['slug'], unknown_key_count: 0, approx_bytes: 1024 },
    };
    const pageMissing = describeFeedError(pageMissingEvent);
    expect(pageMissing).toEqual({
      title: 'Страница не найдена',
      reason: 'Страница с указанным адресом не найдена.',
      nextAction: 'Проверьте адрес страницы или найдите её через поиск.',
      code: 'page_not_found',
    });

    const sourceMissing = describeFeedError({
      agent: 'agent-a', operation: 'code_blast', scopes: '', latency_ms: 8, status: 'error',
      timestamp: '2026-08-06T03:46:18.000Z',
      error: { code: 'op_error', message: 'Code traversal runs against a single source. Specify source_id.' },
    });
    expect(sourceMissing.title).toBe('Не указан источник кода');
    expect(sourceMissing.reason).not.toContain('source_id');
    expect(sourceMissing.nextAction).toContain('source_id');
    expect(formatSafeParams(pageMissingEvent.params)).toBe('Поля: slug · размер около 1024 Б');
    const safeSummary = formatSafeParams({
      redacted: true,
      declared_keys: ['query'],
      query: 'secret-value-must-not-render',
      unknown_key_count: 2,
    });
    expect(safeSummary).toBe('Поля: query · неизвестных полей: 2');
    expect(safeSummary).not.toContain('secret-value-must-not-render');
    const untrustedSummary = formatSafeParams({
      declared_keys: ['secret-value-must-not-copy'],
      unknown_key_count: 7,
      approx_bytes: 123,
    });
    expect(untrustedSummary).toBe('Значения и метаданные параметров скрыты');
    expect(untrustedSummary).not.toContain('secret-value-must-not-copy');
    expect(pageMissing.reason).not.toContain('projects/example');
  });

  test('Dashboard error status has hover summary and click-to-expand diagnostics', () => {
    const dashboard = read('admin/src/pages/Dashboard.tsx');
    expect(dashboard).toContain('error_message: row.error_message');
    expect(dashboard).toContain('params: row.params');
    expect(dashboard).toContain('ui_key: `sse-${crypto.randomUUID()}`');
    expect(dashboard).toContain('className={`badge badge-${e.status} feed-error-toggle`}');
    expect(dashboard).toContain('aria-expanded={isExpanded}');
    expect(dashboard).toContain('aria-controls={detailId}');
    expect(dashboard).not.toContain("role={isError ? 'button' : undefined}");
    expect(dashboard).not.toContain('tabIndex={isError ? 0 : undefined}');
    expect(dashboard).toContain('title={diagnostic?.title}');
    expect(dashboard).toContain('Технический текст ошибки не включён');
    expect(dashboard).not.toContain('`Причина: ${diagnostic.reason}`');
    expect(dashboard).toContain('Скопировать диагностику');
    expect(dashboard).toContain('Что делать');
    expect(dashboard).toContain('Идентификатор запроса');
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
    expect(merge).toContain('left.latency_ms === right.latency_ms');
    expect(dashboard).not.toContain('Reconnect handled by browser EventSource auto-retry');
    expect(server).toContain("res.setHeader('X-Accel-Buffering', 'no')");
    expect(server).toContain("res.write('retry: 3000\\n: connected\\n\\n')");
    expect(server).toContain("res.write(': heartbeat\\n\\n')");
    expect(server).toContain('async function persistRequestLog');
    expect(server).toContain('RETURNING id');
    expect(server).toContain('id: requestLogId');

    const webhookStart = server.indexOf("const job = await ingestQueue.add");
    const webhookEnd = server.indexOf("res.status(202).json", webhookStart);
    const webhookSuccess = server.slice(webhookStart, webhookEnd);
    expect(webhookSuccess).toContain('const requestLogId = await persistRequestLog({');
    expect(webhookSuccess).toContain("operation: 'webhook_ingest'");
    expect(webhookSuccess).toContain('id: requestLogId');
    expect(webhookSuccess).not.toContain('executeRawJsonb(');
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
