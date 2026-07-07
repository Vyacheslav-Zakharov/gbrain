import React, { useState } from 'react';

type Props = {
  busy: string | null;
  onSelectArea: (area: 'connectors' | 'base_views' | 'transform_views' | 'article_views') => void;
  onSeedArticle: () => void;
};

const steps = [
  '1 Подключение',
  '2 Таблица',
  '3 Поля',
  '4 SQL (опц.)',
  '5 Статья',
  '6 Превью и утверждение',
];

export function SourceIngestWizard({ busy, onSelectArea, onSeedArticle }: Props) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  if (!open) {
    return <button className="btn btn-primary" disabled={busy !== null} onClick={() => setOpen(true)}>+ Новая публикация</button>;
  }
  return <section style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 12, marginBottom: 14, background: 'rgba(15,23,42,0.52)' }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', marginBottom: 10 }}>
      <div>
        <b>Мастер «Новая публикация»</b>
        <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>Каждый шаг сохраняет настоящие catalog objects через соответствующий редактор; черновики остаются в дереве.</div>
      </div>
      <button className="btn btn-secondary" onClick={() => setOpen(false)}>Close</button>
    </div>
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
      {steps.map((label, i) => <button key={label} className={i === step ? 'btn btn-primary' : 'btn btn-secondary'} onClick={() => setStep(i)}>{label}</button>)}
    </div>
    <div style={{ color: 'var(--text-secondary)', marginBottom: 12 }}>
      {step === 0 && 'Выберите или создайте connector, сохраните credentials и выполните Test connector credentials.'}
      {step === 1 && 'Создайте Base view из таблицы/объекта connector-а.'}
      {step === 2 && 'Выполните Execute / Discover fields, выберите stable id, updated-at и carry-forward поля.'}
      {step === 3 && 'При необходимости создайте Transform view: aliases + read-only SQL + preview.'}
      {step === 4 && 'Создайте Article view: тип, target source, slug/identity, template sections.'}
      {step === 5 && 'Соберите preview, проверьте PII/routing/empty slots, затем approve/freeze и trial batch.'}
    </div>
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <button className="btn btn-secondary" onClick={() => { setStep(0); onSelectArea('connectors'); }}>Открыть подключения</button>
      <button className="btn btn-secondary" onClick={() => { setStep(1); onSelectArea('base_views'); }}>Открыть источники</button>
      <button className="btn btn-secondary" onClick={() => { setStep(3); onSelectArea('transform_views'); }}>Открыть SQL</button>
      <button className="btn btn-primary" onClick={() => { setStep(4); onSeedArticle(); onSelectArea('article_views'); }}>Продолжить в публикации</button>
    </div>
  </section>;
}
