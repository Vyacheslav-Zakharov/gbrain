/**
 * v0.36.1.0 (T15 / E6) — Calibration tab.
 *
 * Fetches the active calibration profile + 4 server-rendered SVG charts.
 * Layout: Linear calm clarity (per D23 mockup variant-B) — single column,
 * generous whitespace, ONE big sparkline as hero, then patterns, then
 * domain bars, then abandoned threads.
 *
 * Per D23 — SVG markup comes from the server (image/svg+xml endpoint).
 * Admin SPA renders inside a TrustedSVG wrapper that uses
 * dangerouslySetInnerHTML. XSS posture: server-side escapeXml() on all
 * caller-controlled strings + requireAdmin middleware on the endpoint.
 */

import React, { useEffect, useState } from 'react';
import { api } from '../api';

interface CalibrationProfileSummary {
  holder: string;
  source_id: string;
  generated_at: string;
  published: boolean;
  total_resolved: number;
  brier: number | null;
  accuracy: number | null;
  partial_rate: number | null;
  grade_completion: number;
  pattern_statements: string[];
  active_bias_tags: string[];
  voice_gate_passed: boolean;
  voice_gate_attempts: number;
}

interface ChartSvgProps {
  type: string;
  ariaLabel: string;
}

function TrustedSVG({ markup }: { markup: string }) {
  return (
    <div
      style={{ width: '100%', overflow: 'auto' }}
      // Server-rendered SVG (image/svg+xml) gated by requireAdmin middleware.
      // All caller-controlled strings pass through escapeXml() server-side.
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
}

function ChartSvg({ type, ariaLabel }: ChartSvgProps) {
  const [markup, setMarkup] = useState<string>('');
  const [error, setError] = useState<string>('');

  useEffect(() => {
    let cancelled = false;
    api
      .calibrationChart(type)
      .then(svg => {
        if (!cancelled) setMarkup(svg);
      })
      .catch(err => {
        if (!cancelled) setError(err.message ?? 'fetch failed');
      });
    return () => {
      cancelled = true;
    };
  }, [type]);

  if (error) {
    return (
      <div style={{ padding: 16, color: 'var(--error)' }} role="alert">
        {ariaLabel}: {error}
      </div>
    );
  }
  if (!markup) {
    return <div style={{ padding: 16, color: 'var(--text-muted)' }}>{ariaLabel} loading...</div>;
  }
  return <TrustedSVG markup={markup} />;
}

export function CalibrationPage() {
  const [profile, setProfile] = useState<CalibrationProfileSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>('');
  const [startError, setStartError] = useState<string>('');
  const [retryKey, setRetryKey] = useState(0);
  const [starting, setStarting] = useState(false);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    setLoading(true);
    setLoadError('');
    api
      .calibrationProfile()
      .then(p => {
        setProfile(p);
        setLoading(false);
      })
      .catch(err => {
        setLoadError(err.message ?? 'fetch failed');
        setLoading(false);
      });
  }, [retryKey]);

  const startCalibration = async () => {
    if (!confirm('Создать профиль калибровки сейчас? Задача может использовать LLM и занять несколько минут.')) return;
    setStarting(true);
    setStartError('');
    try {
      const result = await api.startCalibration();
      if (result.status === 'active') {
        setNotice(`Задача #${result.job_id} уже выполняется. Ход выполнения виден в разделе «Задания».`);
      } else if (['waiting', 'delayed', 'waiting-children', 'paused'].includes(result.status)) {
        setNotice(`Задача #${result.job_id} находится в очереди. Ход выполнения виден в разделе «Задания».`);
      } else if (result.status === 'completed') {
        setNotice(`Задача #${result.job_id} уже завершена. Обновите страницу; если профиль не появился, проверьте наличие пяти оценённых тезисов.`);
      } else {
        setStartError(`Задача #${result.job_id} имеет статус «${result.status}». Повторите запуск через минуту или откройте раздел «Задания».`);
      }
    } catch (err) {
      setStartError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  };

  if (loading) {
    return <div className="page-loading" style={{ padding: 24 }} aria-busy="true"><span className="loading-spinner" />Загружаем профиль калибровки…</div>;
  }
  if (loadError) {
    return (
      <div className="page-error" style={{ margin: 24 }} role="alert">
        <strong>Не удалось загрузить профиль калибровки</strong>
        <span>{loadError}</span>
        <button className="btn btn-secondary" onClick={() => setRetryKey(value => value + 1)}>Повторить</button>
      </div>
    );
  }
  if (!profile) {
    return (
      <div style={{ padding: 24, maxWidth: 700 }}>
        <h1 style={{ marginBottom: 16 }}>Калибровка</h1>
        <p style={{ color: 'var(--text-secondary)' }}>
          Профиль калибровки ещё не создан. Он строится после пяти или более оценённых takes.
        </p>
        <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>
          Запуск выполняется как контролируемая фоновая задача. Возможны расходы на LLM.
        </p>
        <button className="btn btn-primary" disabled={starting} onClick={() => void startCalibration()}>
          {starting ? 'Ставим задачу в очередь…' : 'Создать профиль калибровки'}
        </button>
        {notice && <div className="receipt" role="status" style={{ marginTop: 14 }}>{notice}</div>}
        {startError && <div className="page-error" role="alert" style={{ marginTop: 14 }}>{startError}</div>}
      </div>
    );
  }

  const generated = new Date(profile.generated_at);
  const generatedAgo = Math.floor((Date.now() - generated.getTime()) / (1000 * 60 * 60 * 24));

  return (
    <div style={{ padding: 32, maxWidth: 720 }}>
      <h1 style={{ marginBottom: 8 }}>Калибровка</h1>
      <div style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 24 }}>
        Владелец: {profile.holder}
        {' · '}
        Обновлено {generatedAgo === 0 ? 'сегодня' : `${generatedAgo} дн. назад`}
        {profile.published && ' · опубликовано'}
        {profile.grade_completion < 0.9 && ` · оценено ~${Math.round(profile.grade_completion * 100)}%`}
        {!profile.voice_gate_passed && ' · voice gate использовал шаблон'}
      </div>

      <section style={{ marginBottom: 32 }}>
        <ChartSvg type="brier-trend" ariaLabel="Динамика Brier score" />
      </section>

      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 12, fontWeight: 400 }}>
          Выявленные паттерны
        </h2>
        <ChartSvg type="pattern-statements" ariaLabel="Выявленные паттерны" />
      </section>

      <section style={{ marginBottom: 32 }}>
        <ChartSvg type="domain-bars" ariaLabel="Точность по областям" />
      </section>

      <section style={{ marginBottom: 32 }}>
        <ChartSvg type="abandoned-threads" ariaLabel="Заброшенные направления" />
      </section>

      {profile.active_bias_tags.length > 0 && (
        <section style={{ marginBottom: 32, color: 'var(--text-muted)', fontSize: 13 }}>
          Активные bias tags: {profile.active_bias_tags.join(', ')}
        </section>
      )}
    </div>
  );
}
