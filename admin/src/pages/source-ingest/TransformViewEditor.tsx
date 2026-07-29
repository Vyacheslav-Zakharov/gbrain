import React from 'react';
import { DangerZone } from './shared';

type Busy = string | null;
type TransformViewForm = {
  transform_view_id: string;
  display_name: string;
  inputs_text: string;
  sql: string;
  primary_key_field: string;
  updated_at_field: string;
};

type Props = {
  busy: Busy;
  transformViewForm: TransformViewForm;
  setTransformViewForm: React.Dispatch<React.SetStateAction<TransformViewForm>>;
  parsedInputsCount: number;
  canTransformPreview: boolean;
  catalogBaseViews: Array<Record<string, unknown>>;
  transformPreview: unknown;
  transformViewSaveResult: unknown;
  seedTransformViewFromBase: () => void;
  generateSelectForTransform: () => void;
  runTransformPreview: () => void;
  saveTransformView: () => void;
  deleteTransformView: () => void;
  appendBaseViewInput: (baseViewId: string) => void;
  TransformResultPreview: React.ComponentType<{ value: unknown }>;
  PreviewJson: React.ComponentType<{ value: unknown; empty: string }>;
  studioSectionStyle: (area: string) => React.CSSProperties;
};

export function TransformViewEditor({ busy, transformViewForm, setTransformViewForm, parsedInputsCount, canTransformPreview, catalogBaseViews, transformPreview, transformViewSaveResult, seedTransformViewFromBase, generateSelectForTransform, runTransformPreview, saveTransformView, deleteTransformView, appendBaseViewInput, TransformResultPreview, PreviewJson, studioSectionStyle }: Props) {
  return <section style={studioSectionStyle('transform_views')}>
    <h2 className="section-title">3. Преобразование (Transform view)</h2>
    <p style={{ color: 'var(--text-muted)', marginTop: -6 }}>
      Преобразование объединяет входные источники, read-only SQL и поля идентификации результата. SQL сохраняется как метаданные каталога и выполняется только в staging PGLite для предпросмотра.
    </p>
    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
      <button className="btn btn-secondary" disabled={busy !== null} onClick={seedTransformViewFromBase}>Заполнить из выбранного источника</button>
      <button className="btn btn-secondary" disabled={busy !== null || parsedInputsCount === 0} onClick={generateSelectForTransform}>Создать SELECT</button>
      <button className="btn btn-primary source-ingest-context-primary" disabled={busy !== null || !canTransformPreview} onClick={() => void runTransformPreview()}>{busy === 'transform-preview' ? 'Выполняем…' : 'Проверить SQL'}</button>
      <button className="btn btn-secondary" disabled={busy !== null || !transformViewForm.transform_view_id || parsedInputsCount === 0 || !transformViewForm.sql.trim() || !transformViewForm.primary_key_field} onClick={() => void saveTransformView()}>{busy === 'catalog-transform-view' ? 'Сохраняем…' : 'Сохранить преобразование'}</button>
      <span style={{ color: 'var(--text-muted)', alignSelf: 'center' }}>Входы связывают алиасы с источниками. Автоматический SELECT — только заготовка; JOIN задаётся явно в SQL.</span>
    </div>
    <DangerZone description="Удаление преобразования может сделать зависимые публикации недействительными. Перед удалением будет показано влияние на каталог.">
      <button className="btn btn-danger" disabled={busy !== null || !transformViewForm.transform_view_id} onClick={() => void deleteTransformView()}>{busy === 'catalog-transform-view-delete' ? 'Удаляем…' : 'Удалить преобразование'}</button>
    </DangerZone>
    <div className="source-ingest-form-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
      <label>ID преобразования
        <input value={transformViewForm.transform_view_id} onChange={e => setTransformViewForm(prev => ({ ...prev, transform_view_id: e.target.value }))} placeholder="tv-vehicles-clean" />
      </label>
      <label>Название
        <input value={transformViewForm.display_name} onChange={e => setTransformViewForm(prev => ({ ...prev, display_name: e.target.value }))} placeholder="Автотранспорт transform" />
      </label>
      <label>Поле первичного ключа в результате SQL
        <input value={transformViewForm.primary_key_field} onChange={e => setTransformViewForm(prev => ({ ...prev, primary_key_field: e.target.value }))} placeholder="vehicleID" />
      </label>
      <label>Поле времени обновления в результате SQL
        <input value={transformViewForm.updated_at_field} onChange={e => setTransformViewForm(prev => ({ ...prev, updated_at_field: e.target.value }))} placeholder="max_updated_at" />
      </label>
      {catalogBaseViews.length > 0 && <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {catalogBaseViews.map(row => <button key={String(row.base_view_id)} type="button" className="btn btn-secondary" onClick={() => appendBaseViewInput(String(row.base_view_id))}>Добавить вход {String(row.base_view_id)}</button>)}
      </div>}
      <details style={{ gridColumn: '1 / -1', border: '1px solid var(--border)', borderRadius: 8, padding: 10 }}>
        <summary>Дополнительные настройки</summary>
        <label style={{ display: 'block', marginTop: 10 }}>JSON входов преобразования
          <textarea rows={5} value={transformViewForm.inputs_text} onChange={e => setTransformViewForm(prev => ({ ...prev, inputs_text: e.target.value }))} style={{ width: '100%', fontFamily: 'var(--font-mono)', fontSize: 12 }} />
        </label>
      </details>
      <label style={{ gridColumn: '1 / -1' }}>SQL только для чтения
        <textarea rows={8} value={transformViewForm.sql} onChange={e => setTransformViewForm(prev => ({ ...prev, sql: e.target.value }))} placeholder={"SELECT main.vehicleID, main.govNumber, main.updatedAt AS max_updated_at\nFROM main\nWHERE main.vehicleID IS NOT NULL"} style={{ width: '100%', fontFamily: 'var(--font-mono)', fontSize: 12 }} />
      </label>
      <div style={{ gridColumn: '1 / -1', color: parsedInputsCount > 0 && transformViewForm.sql.trim() ? 'var(--text-muted)' : 'var(--warning)', fontSize: 12 }}>
        Распознано входов: {parsedInputsCount}. Сохранение помечает зависимые публикации устаревшими через <code>source_transform_view_upsert</code>.
      </div>
    </div>
    {transformPreview !== null && <div style={{ marginTop: 12, border: '1px solid var(--border)', borderRadius: 8, padding: 10 }}>
      <h3 style={{ fontSize: 13, marginBottom: 8 }}>Результат предпросмотра SQL</h3>
      <TransformResultPreview value={transformPreview} />
    </div>}
    {transformViewSaveResult !== null && <details style={{ marginTop: 12 }}><summary>Технические детали</summary><PreviewJson value={transformViewSaveResult} empty="Нет результата сохранения." /></details>}
  </section>;
}
