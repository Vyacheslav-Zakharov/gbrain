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
    { area: 'connectors', node: 'connector:new', title: '1. Подключение', short: 'Подключение', cta: 'Открыть подключение', saveLabel: 'Сохранить подключение', body: 'Создайте или выберите подключение. Секреты хранятся отдельно от определений источников, преобразований и публикаций; проверка секретов не выбирает таблицу.' },
    { area: 'base_views', node: 'base_view:new', title: '2. Таблица источника', short: 'Таблица', cta: 'Открыть источник', saveLabel: 'Сохранить источник', body: 'Создайте источник для конкретной таблицы или объекта AppSheet, исследуйте поля и выберите стабильный ID, поле времени обновления и переносимые поля.' },
    { area: 'transform_views', node: 'transform_view:new', title: '3. SQL-преобразование (опционально)', short: 'SQL', cta: 'Открыть преобразование', saveLabel: 'Сохранить преобразование', body: 'Если нужны JOIN, фильтрация или агрегация — создайте преобразование. SQL работает только для чтения; предпросмотр должен показать строки до публикации. Если преобразование не нужно — переходите дальше.' },
    { area: 'article_views', node: 'article_view:new', title: '4. Публикация', short: 'Статья', cta: 'Открыть публикацию', saveLabel: 'Сохранить публикацию', body: 'Создайте публикацию: укажите тип GBrain, целевой источник, slug, правила идентификации и разделы schema-template. Предпросмотр вернёт chain hash.' },
    { area: 'article_views', node: 'section:article_views', title: '5. Предпросмотр → утверждение → пробный запуск', short: 'Проверка', cta: 'Проверить публикации', saveLabel: 'Предпросмотр и фиксация', body: 'Сначала выполните предпросмотр, затем зафиксируйте snapshot и запустите пробный пакет из 20 записей. Устаревшие публикации требуют повторного предпросмотра и утверждения.' },
  ], [counts]);
  const current = steps[step] ?? steps[0];
  const go = (target = current) => {
    if (target.node === 'article_view:new') onSeedArticle();
    onSelectArea(target.area);
    onSelectNode(target.node);
  };
  const navigateToStep = (index: number) => {
    const nextStep = Math.max(0, Math.min(steps.length - 1, index));
    const target = steps[nextStep] ?? steps[0];
    setStep(nextStep);
    go(target);
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
    navigateToStep(step + 1);
  };
  if (!open) {
    return <button className="btn btn-secondary" disabled={busy !== null} onClick={() => { setOpen(true); setWizardErr(null); navigateToStep(0); }}>+ Новая публикация</button>;
  }
  return <section className="source-ingest-wizard--open" style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 12, marginBottom: 14, background: 'rgba(15,23,42,0.52)' }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', marginBottom: 10 }}>
      <div>
        <b>Мастер «Новая публикация»</b>
        <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>На шаге «Сохранить и дальше» текущая сущность сохраняется, затем мастер открывает следующий узел. Горячие клавиши: Alt+1…Alt+5.</div>
      </div>
      <button className="btn btn-secondary" onClick={() => setOpen(false)}>Закрыть</button>
    </div>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 6, marginBottom: 10 }}>
      {steps.map((s, i) => <button key={s.title} className="btn btn-secondary" aria-current={i === step ? 'step' : undefined} onClick={() => navigateToStep(i)} style={{ textAlign: 'left', borderColor: i === step ? 'var(--accent)' : undefined }}>
        <span style={{ display: 'block' }}>{i < step ? '✓' : i === step ? '•' : '○'} {s.short}</span>
        <span style={{ display: 'block', color: 'var(--text-muted)', fontSize: 11 }}>{i === 0 ? `${counts.connectors} подключ.` : i === 1 ? `${counts.baseViews} источн.` : i === 2 ? `${counts.transformViews} преобр.` : i === 3 ? `${counts.articleViews} публ.` : `${counts.staleArticleViews} устар.`}</span>
      </button>)}
    </div>
    <div style={{ borderLeft: '3px solid var(--accent)', padding: '2px 10px', marginBottom: 10 }}>
      <b style={{ fontSize: 14 }}>{current.title}</b>
      <span style={{ color: 'var(--text-secondary)', marginLeft: 8, fontSize: 12 }}>{current.body}</span>
      <div style={{ color: 'var(--text-muted)', marginTop: 4, fontSize: 11 }}><b>Операция сохранения:</b> {current.saveLabel ?? 'Сохранить'}. При ошибке мастер остаётся на текущем шаге.</div>
    </div>
    {wizardErr && <div style={{ color: 'var(--error)', marginBottom: 10, fontSize: 12 }}><b>Ошибка мастера:</b> {wizardErr}</div>}
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <button className="btn btn-secondary" disabled={step === 0 || busy !== null} onClick={() => navigateToStep(step - 1)}>Назад</button>
      <button className="btn btn-secondary" disabled={busy !== null} onClick={() => go()}>{current.cta}</button>
      <button className="btn btn-primary" disabled={busy !== null} onClick={() => void saveAndNext()}>{step >= steps.length - 1 ? 'Предпросмотр публикации' : 'Сохранить и дальше'}</button>
      {step === steps.length - 1 && <button className="btn btn-secondary" disabled={busy !== null} onClick={() => void onApproveArticleView?.()}>Зафиксировать snapshot</button>}
      <button className="btn btn-secondary" disabled={step >= steps.length - 1 || busy !== null} onClick={() => navigateToStep(step + 1)}>Пропустить шаг</button>
    </div>
  </section>;
}
