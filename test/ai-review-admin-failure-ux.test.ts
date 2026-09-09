import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { adminApiErrorMessage } from '../admin/src/api';

describe('AI Review admin failure UX', () => {
  test('prefers the actionable server message over a generic error code', () => {
    expect(adminApiErrorMessage({
      error: 'review_request_failed',
      message: 'Database temporarily unavailable',
    }, 400)).toBe('Database temporarily unavailable');
  });

  test('falls back to the server error code and then HTTP status', () => {
    expect(adminApiErrorMessage({ error: 'conflict' }, 409)).toBe('conflict');
    expect(adminApiErrorMessage({}, 502)).toBe('HTTP 502');
  });

  test('Take Review clears stale rows and counters when a list request fails', () => {
    const source = readFileSync(new URL('../admin/src/pages/AIReview.tsx', import.meta.url), 'utf8');
    expect(source).toContain('setRows([]);');
    expect(source).toContain('setTotal(0);');
    expect(source).toContain('setSelectedId(null);');
  });

  test('Take Review exposes deferred as a separate reversible queue state', () => {
    const page = readFileSync(new URL('../admin/src/pages/AIReview.tsx', import.meta.url), 'utf8');
    const api = readFileSync(new URL('../admin/src/api.ts', import.meta.url), 'utf8');
    const server = readFileSync(new URL('../src/commands/serve-http.ts', import.meta.url), 'utf8');
    expect(page).toContain("deferred: 'Отложены'");
    expect(page).toContain('api.aiReviewDefer');
    expect(page).toContain('api.aiReviewRestore');
    expect(api).toContain('/defer`');
    expect(api).toContain('/restore`');
    expect(server).toContain("proposals/:id/defer");
    expect(server).toContain("proposals/:id/restore");
  });

  test('Concept Review clears stale rows and counters when a list request fails', () => {
    const source = readFileSync(new URL('../admin/src/pages/ConceptReview.tsx', import.meta.url), 'utf8');
    expect(source).toContain('setRows([]);');
    expect(source).toContain('setTotal(0);');
    expect(source).toContain('setSelected(null);');
  });

  test('Meeting Review uses the shared review-console visual hierarchy', () => {
    const source = readFileSync(new URL('../admin/src/pages/MeetingReview.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../admin/src/pages/AIReview.css', import.meta.url), 'utf8');
    const appSource = readFileSync(new URL('../admin/src/App.tsx', import.meta.url), 'utf8');
    expect(source).toContain('className={`proposal-row');
    expect(source).toContain('className="detail-title"');
    expect(source).toContain('className="review-form"');
    expect(source).toContain('className="reject"');
    expect(source).toContain('Требуют решения');
    expect(source).toContain('Готовы автоматически');
    expect(source).toContain('Действий не требуется');
    expect(source).not.toContain('Принять и поставить импорт');
    expect(source).not.toContain('api.meetingReviewAccept');
    expect(source).not.toContain('transactional autopublisher');
    expect(css).toContain('.meeting-review .review-actions{position:static');
    expect(css).toContain('overflow-y:auto;overflow-x:hidden');
    expect(css).toContain('.advisor-message p,.advisor-message dd{overflow-wrap:anywhere;word-break:break-word}');
    expect(source).toContain('detailRequest.current += 1');
    expect(source).toContain('const entityRequest = useRef(0)');
    expect(source).toContain('const request = ++entityRequest.current');
    expect(source).toContain('request !== entityRequest.current || selectedRef.current !== meetingId');
    expect(source).toContain('const busyToken = `entities:${key}`');
    expect(source).toContain('const listRequest = useRef(0)');
    expect(source).toContain('request !== listRequest.current');
    expect(source).toContain("endBusy('reject')");
    expect(source).toContain("const busyRef = useRef('')");
    expect(source).toContain('if (busyRef.current) return false');
    expect(source).toContain("if (!beginBusy('resolution')) return");
    expect(source).toContain('if (!beginBusy(busyToken)) return');
    expect(source).toContain('endBusy(busyToken)');
    expect(source).toContain('disabled={Boolean(busy)}');
    expect(source).toContain("if (entityToken.startsWith('entities:'))");
    expect(source).toContain("busyRef.current = ''");
    expect(source).toContain("current === entityToken ? '' : current");
    expect(source).toContain('const selectedRef = useRef<string | null>(null)');
    expect(source).toContain('selectedRef.current !== id');
    expect(source).toContain('selectedRef.current !== meetingId');
    expect(source).toContain('const clearSelection = useCallback');
    expect(source).toContain('setDetail(null)');
    expect(source).toContain('selected !== detail.item.id');
    expect(source).toContain('const meetingId = detail.item.id');
    expect(source).toContain('Загружаем карточку встречи…');
    expect(source).toContain('hasRoutingIssue(row) ? `Предварительно:');
    expect(source).toContain('hasRoutingIssue(detail.item) ? `Предварительно:');
    expect(source).toContain('aria-pressed={view === value}');
    expect(source).toContain("aria-current={selected === row.id ? 'true' : undefined}");
    expect(source).toContain('aria-pressed={field === value}');
    expect(source).toContain("setMobileDetail(true)");
    expect(appSource).toContain("meetingReviewItems({ status: 'pending', review_class: 'exception', limit: 1 })");
  });

  test('Meeting Review exposes structured routing and participant resolution controls', () => {
    const source = readFileSync(new URL('../admin/src/pages/MeetingReview.tsx', import.meta.url), 'utf8');
    const serveSource = readFileSync(new URL('../src/commands/serve-http.ts', import.meta.url), 'utf8');
    expect(source).toContain('api.meetingReviewSources');
    expect(source).toContain('api.meetingReviewEntities');
    expect(source).toContain("'internal-logistics': 'Логистика и автотранспорт'");
    expect(source).toContain('api.meetingReviewResolution');
    expect(source).toContain('Предварительно предложено');
    expect(source).toContain('Не выбрано');
    expect(source).toContain('Сопоставить с существующей карточкой');
    expect(source).toContain('Оставить только упоминание');
    expect(source).toContain('Подтвердить предложенный контакт');
    expect(source).toContain('expected_generated_at');
    expect(source).toContain('route_source');
    expect(source).toContain('participant_resolutions');
    expect(source).toContain('Сохранить решение и проверить заново');
    expect(source).not.toContain('api.meetingReviewAccept');
    expect(serveSource).toContain("page.type !== 'person'");
    expect(serveSource).toContain("status === 'active' || status === 'stable'");
    expect(serveSource).toContain('/(?:index|readme)$/i');
  });

  test('Meeting Review offers a non-authoritative LLM advisor dialogue', () => {
    const source = readFileSync(new URL('../admin/src/pages/MeetingReview.tsx', import.meta.url), 'utf8');
    expect(source).toContain('api.meetingReviewAdvisor');
    expect(source).toContain('Советник LLM');
    expect(source).toContain('Скопировать рекомендацию в выбор источника');
    expect(source).toContain('LLM не утверждает и не публикует');
    expect(source).toContain('Свежий предпросмотр остаётся единственным авторитетным результатом');
  });

  test('Meeting Review preserves an explicit exclusion action', () => {
    const source = readFileSync(new URL('../admin/src/pages/MeetingReview.tsx', import.meta.url), 'utf8');
    expect(source).toContain('Исключить из автопубликации');
    expect(source).toContain('Встреча останется в истории, но не попадёт в автоматическую публикацию');
    expect(source).toContain('Почему встречу нужно исключить из автопубликации?');
  });

  test('Meeting Review accept route is a fail-closed kill switch', () => {
    const source = readFileSync(new URL('../src/commands/serve-http.ts', import.meta.url), 'utf8');
    const start = source.indexOf("app.post('/admin/api/meeting-review/items/:id/accept'");
    const end = source.indexOf("app.post('/admin/api/meeting-review/items/:id/reject'", start);
    const route = source.slice(start, end);
    expect(route).toContain("error: 'direct_meeting_accept_disabled'");
    expect(route).toContain('res.status(409)');
    expect(route).not.toContain('enqueueMeetingIngest');
    expect(route).not.toContain("'--apply'");
  });
});
