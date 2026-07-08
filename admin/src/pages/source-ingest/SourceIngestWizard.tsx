import React, { useMemo, useState } from 'react';

type Area = 'connectors' | 'base_views' | 'transform_views' | 'article_views';

type Step = {
  area: Area;
  node: string;
  title: string;
  short: string;
  body: string;
  done?: boolean;
  cta: string;
  saveLabel?: string;
};

type Props = {
  busy: string | null;
  counts: { connectors: number; baseViews: number; transformViews: number; articleViews: number; staleArticleViews: number };
  onSelectArea: (area: Area) => void;
  onSelectNode: (node: string) => void;
  onSeedArticle: () => void;
  onSaveConnector?: () => Promise<void> | void;
  onSaveBaseView?: () => Promise<void> | void;
  onSaveTransformView?: () => Promise<void> | void;
  onSaveArticleView?: () => Promise<void> | void;
  onPreviewArticleView?: () => Promise<void> | void;
  onApproveArticleView?: () => Promise<void> | void;
};

export function SourceIngestWizard({ busy, counts, onSelectArea, onSelectNode, onSeedArticle, onSaveConnector, onSaveBaseView, onSaveTransformView, onSaveArticleView, onPreviewArticleView, onApproveArticleView }: Props) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [wizardErr, setWizardErr] = useState<string | null>(null);
  const steps: Step[] = useMemo(() => [
    { area: 'connectors', node: 'section:connectors', title: '1. Подключение', short: 'Подключение', done: counts.connectors > 0, cta: 'Открыть подключения', saveLabel: 'Сохранить подключение', body: 'Создай или выбери connector. Credentials сохраняются отдельно от article/base/transform definition; проверка credentials не выбирает таблицу.' },
    { area: 'base_views', node: 'base_view:new', title: '2. Таблица источника', short: 'Таблица', done: counts.baseViews > 0, cta: 'Открыть Base view', saveLabel: 'Сохранить источник', body: 'Создай Base view для конкретной AppSheet table/object, выполни Execute / Discover fields и выбери stable id, updated-at и carry-forward поля.' },
    { area: 'transform_views', node: 'transform_view:new', title: '3. SQL-преобразование (опционально)', short: 'SQL', done: counts.transformViews > 0, cta: 'Открыть Transform view', saveLabel: 'Сохранить преобразование', body: 'Если нужен join/filter/aggregate — создай Transform view. SQL read-only, preview должен показать строки до публикации. Если преобразование не нужно — переходи дальше.' },
    { area: 'article_views', node: 'article_view:new', title: '4. Публикация', short: 'Статья', done: counts.articleViews > 0, cta: 'Открыть Article view', saveLabel: 'Сохранить публикацию', body: 'Создай Article view: тип GBrain, target source, slug, identity и schema-template sections. Preview вернёт chain hash.' },
    { area: 'article_views', node: 'section:article_views', title: '5. Preview → Approve → Trial batch', short: 'Проверка', done: counts.articleViews > 0 && counts.staleArticleViews === 0, cta: 'Проверить публикации', saveLabel: 'Preview и freeze', body: 'Сначала preview, затем approve/freeze snapshot, потом trial batch 20. Stale article views требуют повторного preview/approve.' },
  ], [counts]);
  const current = steps[step] ?? steps[0];
  const go = (target = current) => {
    if (target.node === 'article_view:new') onSeedArticle();
    onSelectArea(target.area);
    onSelectNode(target.node);
  };
  const saveCurrent = async () => {
    setWizardErr(null);
    try {
      if (step === 0) await onSaveConnector?.();
      if (step === 1) await onSaveBaseView?.();
      if (step === 2) await onSaveTransformView?.();
      if (step === 3) await onSaveArticleView?.();
      if (step === 4) {
        await onPreviewArticleView?.();
      }
    } catch (e) {
      setWizardErr(e instanceof Error ? e.message : String(e));
      throw e;
    }
  };
  const saveAndNext = async () => {
    await saveCurrent();
    setStep(next => {
      const nextStep = Math.min(steps.length - 1, next + 1);
      const target = steps[nextStep] ?? current;
      setTimeout(() => go(target), 0);
      return nextStep;
    });
  };
  if (!open) {
    return <button className="btn btn-primary" disabled={busy !== null} onClick={() => setOpen(true)}>+ Новая публикация</button>;
  }
  return <section style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 12, marginBottom: 14, background: 'rgba(15,23,42,0.52)' }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', marginBottom: 10 }}>
      <div>
        <b>Мастер «Новая публикация»</b>
        <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>Embedded flow: на шаге «Сохранить и дальше» выполняется upsert текущей сущности, затем мастер переводит к следующему узлу. Горячие клавиши: Alt+1…Alt+5.</div>
      </div>
      <button className="btn btn-secondary" onClick={() => setOpen(false)}>Закрыть</button>
    </div>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8, marginBottom: 12 }}>
      {steps.map((s, i) => <button key={s.title} className={i === step ? 'btn btn-primary' : 'btn btn-secondary'} onClick={() => { setStep(i); go(s); }} style={{ textAlign: 'left' }}>
        <span style={{ display: 'block' }}>{s.done ? '✓' : '○'} {s.short}</span>
        <span style={{ display: 'block', color: 'var(--text-muted)', fontSize: 11 }}>{i === 0 ? `${counts.connectors} подключ.` : i === 1 ? `${counts.baseViews} источн.` : i === 2 ? `${counts.transformViews} преобр.` : i === 3 ? `${counts.articleViews} публ.` : `${counts.staleArticleViews} stale`}</span>
      </button>)}
    </div>
    <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12, marginBottom: 12 }}>
      <h3 style={{ margin: 0, fontSize: 15 }}>{current.title}</h3>
      <p style={{ color: 'var(--text-secondary)', marginBottom: 0 }}>{current.body}</p>
      <p style={{ color: 'var(--text-muted)', marginBottom: 0, fontSize: 12 }}><b>Upsert step:</b> {current.saveLabel ?? 'Сохранить'} — использует значения из формы редактора ниже. Ошибка остаётся в мастере и не переводит на следующий шаг.</p>
    </div>
    {wizardErr && <div style={{ color: 'var(--error)', marginBottom: 10, fontSize: 12 }}><b>Wizard error:</b> {wizardErr}</div>}
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <button className="btn btn-secondary" disabled={step === 0 || busy !== null} onClick={() => setStep(Math.max(0, step - 1))}>Назад</button>
      <button className="btn btn-secondary" disabled={busy !== null} onClick={() => go()}>{current.cta}</button>
      <button className="btn btn-primary" disabled={busy !== null} onClick={() => void saveAndNext()}>{step >= steps.length - 1 ? 'Preview публикации' : 'Сохранить и дальше'}</button>
      {step === steps.length - 1 && <button className="btn btn-secondary" disabled={busy !== null} onClick={() => void onApproveArticleView?.()}>Freeze snapshot</button>}
      <button className="btn btn-secondary" disabled={step >= steps.length - 1 || busy !== null} onClick={() => setStep(Math.min(steps.length - 1, step + 1))}>Пропустить шаг</button>
    </div>
  </section>;
}
