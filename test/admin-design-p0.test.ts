import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('Admin design P0 contracts', () => {
  test('navigation is Russian and surfaces pending AI review count', () => {
    const app = read('admin/src/App.tsx');
    const css = read('admin/src/index.css');
    expect(app).toContain("label: 'Проверка AI'");
    expect(app).toContain("label: 'Импорт данных'");
    expect(app).toContain('nav-badge');
    expect(app).toContain("status: 'pending', limit: 1");
    expect(app).toContain('mobile-nav-toggle');
    expect(app).toContain('aria-controls="admin-sidebar"');
    expect(css).toContain('.app.mobile-nav-open .sidebar');
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
  });
});
