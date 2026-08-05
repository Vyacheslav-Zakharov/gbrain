import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import './AIReview.css';

type Status = 'pending' | 'accepted' | 'rejected';
type ReviewClass = 'ready' | 'exception';
type View = ReviewClass | 'accepted' | 'rejected';
type DraftField = 'canonical_markdown' | 'shared_markdown' | 'split_markdown';
type Draft = Record<DraftField, string>;
type Attention = { kind: string; title: string; detail: string; action: string; value?: string };
type ParticipantAction = '' | 'map_existing' | 'mention_only' | 'approve_proposed_contact';
type ParticipantResolution = { action: ParticipantAction; target_slug?: string; label?: string };
type SourceOption = { id: string; label: string; description: string };
type EntityOption = { slug: string; title: string; kind: string };
type Advice = {
  id?: number;
  question: string;
  answer: string;
  recommended_source: string | null;
  confidence: 'high' | 'medium' | 'low';
  rationale: string;
};
type ResolutionRecord = {
  reason?: string;
  resolution?: {
    route_source?: string;
    participant_resolutions?: Record<string, ParticipantResolution>;
  };
};

type Item = {
  id: string;
  topic: string;
  date: string;
  slug: string;
  source: string;
  split_source: string | null;
  shared_stub?: boolean;
  status: Status;
  route_reason: string;
  review_class: ReviewClass;
  attention: Attention[];
  needs_review: Array<Record<string, unknown>>;
  created_stubs: string[];
  generated_at: string;
  job_id?: number;
  draft?: Draft;
};

type Detail = {
  item: Item;
  resolution?: ResolutionRecord;
  resolution_locked?: boolean;
  revisions: Array<Record<string, unknown>>;
  advice: Advice[];
  events: Array<Record<string, unknown>>;
};
type Counts = Record<ReviewClass, number>;

const VIEW_LABELS: Record<View, string> = {
  exception: 'Требуют решения',
  ready: 'Готовы автоматически',
  accepted: 'Приняты ранее',
  rejected: 'Отклонены',
};
const FIELD_LABELS: Record<DraftField, string> = {
  canonical_markdown: 'Закрытый документ',
  shared_markdown: 'Сокращённый общий документ',
  split_markdown: 'Профильная выжимка',
};
const EMPTY_DRAFT: Draft = { canonical_markdown: '', shared_markdown: '', split_markdown: '' };
function isParticipantIssue(item: Attention) {
  if (item.kind === 'participant_unresolved') return Boolean(item.value);
  if (!item.value || !['participant_stub_created', 'planned_stub'].includes(item.kind)) return false;
  const value = item.value.replace(/^shared:/, '');
  return value.startsWith('hcm/employees/') || value.startsWith('counterparties/contacts/');
}
const SOURCE_LABELS: Record<string, string> = {
  shared: 'Общая база знаний',
  'internal-accounting': 'Бухгалтерия',
  'internal-hr': 'Кадры',
  'internal-legal': 'Юридическая служба',
  'internal-procurement': 'Снабжение и закупки',
  'internal-production': 'Производство',
  'internal-sales-marketing': 'Продажи и маркетинг',
  'internal-management': 'Руководство',
  'internal-safety': 'Охрана труда и безопасность',
  'internal-it': 'ИТ',
};

function sourceLabel(source: string) { return SOURCE_LABELS[source] || source; }

function hasRoutingIssue(item: Pick<Item, 'attention'>) {
  return item.attention.some(attention => attention.kind === 'routing_unresolved');
}

function publicationTarget(item: Item, routeSource: string, routingUnresolved: boolean) {
  if (routingUnresolved) {
    return routeSource
      ? `${sourceLabel(routeSource)} · дополнительные представления определит повторная проверка`
      : 'Не выбрано';
  }
  const targets = [sourceLabel(item.source)];
  if (item.split_source && item.split_source !== item.source) targets.push(sourceLabel(item.split_source));
  if (item.source !== 'shared' && item.shared_stub) targets.push('сокращённая страница в общей базе');
  return targets.join(' + ');
}

function itemStatusLabel(item: Item) {
  if (item.status === 'accepted') return 'Принята ранее';
  if (item.status === 'rejected') return 'Отклонена';
  return item.review_class === 'exception' ? 'Нужно решение' : 'Готово автоматически';
}

function requestFilter(view: View) {
  if (view === 'accepted' || view === 'rejected') return { status: view };
  return { status: 'pending', review_class: view };
}

export function MeetingReviewPage() {
  const [view, setView] = useState<View>('exception');
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<Item[]>([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<Counts>({ exception: 0, ready: 0 });
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [field, setField] = useState<DraftField>('canonical_markdown');
  const [sources, setSources] = useState<SourceOption[]>([]);
  const [routeSource, setRouteSource] = useState('');
  const [participantResolutions, setParticipantResolutions] = useState<Record<string, ParticipantResolution>>({});
  const [entityQuery, setEntityQuery] = useState<Record<string, string>>({});
  const [entityRows, setEntityRows] = useState<Record<string, EntityOption[]>>({});
  const [note, setNote] = useState('');
  const [advice, setAdvice] = useState<Advice[]>([]);
  const [advisorQuestion, setAdvisorQuestion] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [mobileDetail, setMobileDetail] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const detailRequest = useRef(0);
  const entityRequest = useRef(0);
  const listRequest = useRef(0);
  const selectedRef = useRef<string | null>(null);
  const busyRef = useRef('');

  const beginBusy = (token: string) => {
    if (busyRef.current) return false;
    busyRef.current = token;
    setBusy(token);
    return true;
  };
  const endBusy = (token: string) => {
    if (busyRef.current === token) busyRef.current = '';
    setBusy(current => current === token ? '' : current);
  };

  const clearSelection = useCallback(() => {
    const entityToken = busyRef.current;
    if (entityToken.startsWith('entities:')) {
      busyRef.current = '';
      setBusy(current => current === entityToken ? '' : current);
    }
    selectedRef.current = null;
    detailRequest.current += 1;
    entityRequest.current += 1;
    listRequest.current += 1;
    setSelected(null);
    setDetail(null);
    setDetailLoading(false);
  }, []);

  const load = useCallback(async () => {
    const request = ++listRequest.current;
    try {
      const data = await api.meetingReviewItems({ ...requestFilter(view), q: query, limit: 200 });
      if (request !== listRequest.current) return;
      setRows(data.rows || []); setTotal(data.total || 0);
      if (view === 'exception' || view === 'ready') setCounts(data.counts || { exception: 0, ready: 0 });
      setError('');
      if (selected && !(data.rows || []).some((row: Item) => row.id === selected)) clearSelection();
    } catch (e) {
      if (request !== listRequest.current) return;
      setRows([]); setTotal(0); setCounts({ exception: 0, ready: 0 }); setError(e instanceof Error ? e.message : String(e));
    }
  }, [view, query, selected, clearSelection]);

  const loadDetail = useCallback(async (id: string) => {
    if (selectedRef.current !== id) return;
    const request = ++detailRequest.current;
    setDetailLoading(true);
    try {
      const data = await api.meetingReviewItem(id) as Detail;
      if (request !== detailRequest.current || selectedRef.current !== id) return;
      const saved = data.resolution?.resolution;
      setDetail(data);
      setDraft({ ...EMPTY_DRAFT, ...(data.item.draft || {}) });
      setRouteSource(saved?.route_source || '');
      setParticipantResolutions(saved?.participant_resolutions || {});
      entityRequest.current += 1;
      setEntityQuery({}); setEntityRows({}); setNote(data.resolution?.reason || '');
      setAdvice([...(data.advice || [])].reverse()); setAdvisorQuestion('');
      setError(''); setNotice('');
      setField(data.item.draft?.canonical_markdown ? 'canonical_markdown' : data.item.draft?.shared_markdown ? 'shared_markdown' : 'split_markdown');
    } catch (e) {
      if (request === detailRequest.current && selectedRef.current === id) {
        setDetail(null);
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (request === detailRequest.current && selectedRef.current === id) setDetailLoading(false);
    }
  }, []);

  useEffect(() => { const timer = window.setTimeout(load, 180); return () => window.clearTimeout(timer); }, [load]);
  useEffect(() => {
    if (selected) void loadDetail(selected);
    else clearSelection();
  }, [selected, loadDetail, clearSelection]);
  useEffect(() => {
    let active = true;
    void api.meetingReviewSources().then((data: { rows?: SourceOption[] }) => { if (active) setSources(data.rows || []); })
      .catch(e => { if (active) setError(e instanceof Error ? e.message : String(e)); });
    return () => { active = false; };
  }, []);

  const choose = (id: string) => {
    const entityToken = busyRef.current;
    if (entityToken.startsWith('entities:')) {
      busyRef.current = '';
      setBusy(current => current === entityToken ? '' : current);
    }
    selectedRef.current = id;
    detailRequest.current += 1;
    entityRequest.current += 1;
    listRequest.current += 1;
    setDetail(null);
    setDetailLoading(true);
    setSelected(id);
    setMobileDetail(true);

    setError('');
    setNotice('');
  };
  const reject = async () => {
    if (!selected || !detail || selected !== detail.item.id) return;
    const meetingId = detail.item.id;
    const reason = prompt('Почему встречу нужно исключить из автопубликации?\n\nВстреча останется в истории, но не попадёт в автоматическую публикацию.');
    if (reason === null) return;
    if (!reason.trim()) { setError('Укажите причину исключения из автопубликации.'); return; }
    if (!beginBusy('reject')) return; setError('');
    try {
      await api.meetingReviewReject(meetingId, reason.trim());
      if (selectedRef.current !== meetingId) return;
      await load();
      if (selectedRef.current === meetingId) clearSelection();
    } catch (e) {
      if (selectedRef.current === meetingId) setError(e instanceof Error ? e.message : String(e));
    } finally { endBusy('reject'); }
  };
  const refresh = async () => {
    if (!beginBusy('refresh')) return; setError(''); setNotice('');
    try { const result = await api.meetingReviewRefresh(); setNotice(`Предпросмотр поставлен в очередь: задание #${result.job_id}. После завершения обновите список.`); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { endBusy('refresh'); }
  };
  const updateParticipant = (key: string, patch: Partial<ParticipantResolution>) => {
    setParticipantResolutions(current => ({ ...current, [key]: { action: current[key]?.action || '', ...current[key], ...patch } }));
  };
  const searchEntities = async (key: string) => {
    if (busyRef.current || !detail || selectedRef.current !== detail.item.id) return;
    const meetingId = detail.item.id;
    const request = ++entityRequest.current;
    const q = (entityQuery[key] || '').trim();
    if (!q) { setEntityRows(current => ({ ...current, [key]: [] })); return; }
    const busyToken = `entities:${key}`;
    if (!beginBusy(busyToken)) return; setError('');
    try {
      const data = await api.meetingReviewEntities(q) as { rows?: EntityOption[] };
      if (request !== entityRequest.current || selectedRef.current !== meetingId) return;
      setEntityRows(current => ({ ...current, [key]: data.rows || [] }));
    } catch (e) {
      if (request === entityRequest.current && selectedRef.current === meetingId) setError(e instanceof Error ? e.message : String(e));
    } finally {
      endBusy(busyToken);
    }
  };
  const saveResolution = async () => {
    if (!selected || !detail || selected !== detail.item.id || detail.resolution_locked) return;
    const meetingId = detail.item.id;
    const selectedParticipantEntries = Object.entries(participantResolutions).filter(([, value]) => value.action);
    if (!routeSource && selectedParticipantEntries.length === 0) { setError('Выберите хотя бы одно конкретное решение.'); return; }
    if (selectedParticipantEntries.some(([, value]) => value.action === 'map_existing' && !value.target_slug)) { setError('Для сопоставления выберите точную каноническую карточку.'); return; }
    if (selectedParticipantEntries.some(([, value]) => value.action === 'mention_only' && !value.label?.trim())) { setError('Для обычного упоминания укажите отображаемое имя.'); return; }
    if (selectedParticipantEntries.some(([, value]) => value.label && (/[\[\]<>*_`#|\\@]/u.test(value.label)
      || /\b(?:https?:\/\/|www\.)/iu.test(value.label)
      || /^(?:[>+-]\s|\d+\.\s)/u.test(value.label)))) {
      setError('Отображаемое имя должно быть обычным текстом без ссылок и Markdown-разметки.'); return;
    }
    const structuredParticipants = Object.fromEntries(selectedParticipantEntries
      .map(([key, value]) => [key, {
        action: value.action,
        ...(value.action === 'map_existing' && value.target_slug ? { target_slug: value.target_slug } : {}),
        ...(value.label?.trim() ? { label: value.label.trim() } : {}),
      }]));
    if (!beginBusy('resolution')) return; setError(''); setNotice('');
    try {
      const result = await api.meetingReviewResolution(meetingId, {
        expected_generated_at: detail.item.generated_at,
        ...(routeSource ? { route_source: routeSource } : {}),
        ...(Object.keys(structuredParticipants).length ? { participant_resolutions: structuredParticipants } : {}),
        note: note.trim(),
      }) as { job_id: number | null; message?: string };
      await loadDetail(meetingId);
      if (selectedRef.current !== meetingId) return;
      setNotice(result.job_id
        ? `Решение сохранено. Повторная проверка поставлена в очередь: задание #${result.job_id}. Свежий предпросмотр остаётся единственным авторитетным результатом.`
        : `${result.message || 'Решение сохранено, но повторная проверка не поставлена в очередь.'} Свежий предпросмотр остаётся единственным авторитетным результатом.`);
    } catch (e) { if (selectedRef.current === meetingId) setError(e instanceof Error ? e.message : String(e)); }
    finally { endBusy('resolution'); }
  };
  const askAdvisor = async () => {
    if (!selected || !detail || selected !== detail.item.id || !advisorQuestion.trim()) return;
    const meetingId = detail.item.id;
    if (!beginBusy('advisor')) return; setError('');
    try {
      const response = await api.meetingReviewAdvisor(meetingId, advisorQuestion.trim()) as Advice;
      if (selectedRef.current !== meetingId) return;
      setAdvice(current => [...current, response]); setAdvisorQuestion('');
    } catch (e) { if (selectedRef.current === meetingId) setError(e instanceof Error ? e.message : String(e)); }
    finally { endBusy('advisor'); }
  };

  const routingUnresolved = Boolean(detail?.item.attention.some(item => item.kind === 'routing_unresolved'));
  const selectedSource = sources.find(source => source.id === routeSource);
  const participantIssues = detail?.item.attention.filter(isParticipantIssue) || [];
  const hasStructuredIssues = routingUnresolved || participantIssues.length > 0;

  return <div className="ai-review meeting-review">
    <header className="ai-review-header"><div><h1>Проверка встреч</h1><p>Ручное решение требуется только для конкретных исключений. Встречи без замечаний публикуются автоматически по безопасной процедуре.</p></div><div className="ai-review-count">{VIEW_LABELS[view]}: {total}</div></header>
    <div className="ai-review-toolbar">
      <div className="ai-review-tabs" role="group" aria-label="Состояние встреч">{(['exception', 'ready', 'accepted', 'rejected'] as View[]).map(value => <button type="button" key={value} aria-pressed={view === value} className={view === value ? 'active' : ''} onClick={() => { setView(value); clearSelection(); setMobileDetail(false); }}>{VIEW_LABELS[value]}{value === 'exception' || value === 'ready' ? ` (${counts[value]})` : ''}</button>)}</div>
      <input aria-label="Поиск встреч" placeholder="Поиск по теме, дате или источнику" value={query} onChange={e => { clearSelection(); setMobileDetail(false); setQuery(e.target.value); }} />
      <button type="button" disabled={Boolean(busy)} onClick={refresh}>{busy === 'refresh' ? 'Обновляем…' : 'Обновить предпросмотр'}</button>
    </div>
    {error && <div className="ai-review-error" role="alert"><span>{error}</span><button type="button" onClick={() => setError('')} aria-label="Закрыть сообщение">×</button></div>}
    {notice && <div className="receipt" role="status">{notice}</div>}
    <div className={`ai-review-grid ${mobileDetail ? 'show-detail' : ''}`}>
      <section className="proposal-list" aria-label="Очередь встреч">
        {rows.length === 0 && <div className="empty-state"><strong>В этой категории встреч нет</strong><span>Измените фильтр или поисковый запрос.</span></div>}
        {rows.map(row => <button type="button" key={row.id} aria-current={selected === row.id ? 'true' : undefined} className={`proposal-row ${selected === row.id ? 'selected' : ''}`} onClick={() => choose(row.id)}>
          <div className="proposal-row-top"><span>{row.date}</span><span>{hasRoutingIssue(row) ? `Предварительно: ${sourceLabel(row.source)}` : sourceLabel(row.source)}</span><span>{itemStatusLabel(row)}</span></div>
          <strong>{row.topic}</strong>
          <div className="proposal-row-preview">{row.review_class === 'exception' ? row.attention[0]?.title || 'Требуется проверка' : 'Проверки пройдены · действий не требуется'}</div>
          <div className="proposal-row-meta">{row.slug}{row.job_id ? ` · job #${row.job_id}` : ''}</div>
        </button>)}
      </section>
      <section className="proposal-detail" aria-label="Карточка встречи">{detailLoading ? <div className="empty-state"><span className="loading-spinner" aria-hidden="true"/><strong>Загружаем карточку встречи…</strong></div> : detail ? <>
        <button type="button" className="mobile-back" onClick={() => setMobileDetail(false)}>← К очереди</button>
        <div className="detail-title"><div><span className={`status-pill ${detail.item.review_class}`}>{itemStatusLabel(detail.item)}</span> <strong>{detail.item.topic}</strong></div><code>{hasRoutingIssue(detail.item) ? `Предварительно: ${sourceLabel(detail.item.source)} · ${detail.item.slug}` : `${detail.item.source}:${detail.item.slug}`}</code></div>
        {detail.item.review_class === 'ready' ? <div className="meeting-verdict ready"><strong>Проверки пройдены</strong><span>Ошибок, неподтверждённых сущностей и запланированных новых страниц нет.</span><b>Действий не требуется — встреча будет опубликована автоматически.</b></div> : <div className="meeting-verdict exception"><strong>Что требует решения</strong>{detail.item.attention.map((item, index) => <div className="meeting-attention" key={`${item.kind}:${item.value || index}`}><b>{item.title}</b><span>{item.detail}</span><em>Что сделать: {item.action}</em>{item.value && <code>{item.value}</code>}</div>)}</div>}
        <div className="concept-evidence-summary"><strong>Куда будет опубликовано</strong><span>{publicationTarget(detail.item, routeSource, routingUnresolved)}</span></div>

        {detail.resolution_locked && <div className="meeting-resolution resolution-locked" role="alert">
          <h2>Обычное решение недоступно</h2>
          <p>Для этой встречи уже существует legacy override. Нужна отдельная проверяемая recovery с сохранением evidence; форма не будет его перезаписывать.</p>
        </div>}
        {detail.item.status === 'pending' && detail.item.review_class === 'exception' && !detail.resolution_locked && !hasStructuredIssues && <div className="meeting-resolution resolution-locked">
          <h2>Решение вносится в исходной системе</h2>
          <p>Для этого типа исключения безопасной формы пока нет. Исправьте указанный статус или данные в источнике и обновите предпросмотр.</p>
        </div>}
        {detail.item.status === 'pending' && detail.item.review_class === 'exception' && !detail.resolution_locked && hasStructuredIssues && <div className="meeting-resolution" aria-label="Структурированное решение">
          <div className="resolution-heading"><div><h2>Решение по исключениям</h2><p>Сохранение не утверждает и не публикует встречу: оно запускает новую проверку предпросмотра.</p></div></div>
          {routingUnresolved && <fieldset className="resolution-card">
            <legend>Маршрут публикации</legend>
            <div className="preliminary-source"><span>Предварительно предложено</span><strong>{sourceLabel(detail.item.source)}</strong><small>Это диагностическая подсказка, а не подтверждённое место публикации.</small></div>
            <label htmlFor="meeting-route-source">Выберите разрешённый внутренний источник</label>
            <select id="meeting-route-source" value={routeSource} onChange={e => setRouteSource(e.target.value)}>
              <option value="">Не выбрано</option>
              {sources.map(source => <option key={source.id} value={source.id}>{source.label}</option>)}
            </select>
            {selectedSource && <p className="source-description">{selectedSource.description}</p>}
          </fieldset>}

          {participantIssues.map(issue => {
            const key = issue.value!;
            const resolution = participantResolutions[key] || { action: '' };
            const canApprove = (issue.kind === 'participant_stub_created' || issue.kind === 'planned_stub')
              && key.replace(/^shared:/, '').startsWith('counterparties/contacts/');
            return <fieldset className="resolution-card participant-resolution" key={`${issue.kind}:${key}`}>
              <legend>Участник: {key}</legend>
              <label htmlFor={`participant-action-${key}`}>Действие</label>
              <select id={`participant-action-${key}`} value={resolution.action} onChange={e => updateParticipant(key, { action: e.target.value as ParticipantAction, target_slug: undefined })}>
                <option value="">Не выбрано</option>
                <option value="map_existing">Сопоставить с существующей карточкой</option>
                <option value="mention_only">Оставить только упоминание</option>
                {canApprove && <option value="approve_proposed_contact">Подтвердить предложенный контакт</option>}
              </select>
              {resolution.action === 'map_existing' && <div className="entity-search">
                <label htmlFor={`entity-query-${key}`}>Поиск канонической сущности</label>
                <div className="entity-search-row"><input id={`entity-query-${key}`} value={entityQuery[key] || ''} onChange={e => setEntityQuery(current => ({ ...current, [key]: e.target.value }))} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void searchEntities(key); } }} placeholder="Имя или название карточки" /><button type="button" onClick={() => void searchEntities(key)} disabled={Boolean(busy)}>{busy === `entities:${key}` ? 'Ищем…' : 'Найти'}</button></div>
                <label htmlFor={`entity-result-${key}`}>Точное совпадение</label>
                <select id={`entity-result-${key}`} value={resolution.target_slug || ''} onChange={e => updateParticipant(key, { target_slug: e.target.value })}>
                  <option value="">Выберите карточку из результатов</option>
                  {(entityRows[key] || []).map(entity => <option key={entity.slug} value={entity.slug}>{entity.title} · {entity.kind} · {entity.slug}</option>)}
                </select>
                <small>Slug нельзя вводить вручную — выберите точную каноническую карточку.</small>
              </div>}
              {resolution.action === 'mention_only' && <label htmlFor={`participant-label-${key}`}>Как показать имя без ссылки
                <input id={`participant-label-${key}`} maxLength={200} value={resolution.label || ''} onChange={e => updateParticipant(key, { label: e.target.value })} placeholder="Имя участника обычным текстом" />
                <small>Карточка, ссылка и timeline создаваться не будут.</small>
              </label>}
            </fieldset>;
          })}

          <label className="resolution-note" htmlFor="meeting-resolution-note">Комментарий к решению (необязательно)<textarea id="meeting-resolution-note" rows={3} maxLength={2000} value={note} onChange={e => setNote(e.target.value)} /></label>
          <button type="button" className="primary resolution-save" disabled={Boolean(busy)} onClick={() => void saveResolution()}>{busy === 'resolution' ? 'Сохраняем…' : 'Сохранить решение и проверить заново'}</button>
          <p className="authority-note">После сохранения появится номер задания. Свежий предпросмотр остаётся единственным авторитетным результатом; эта форма не применяет изменения напрямую.</p>
        </div>}

        {detail.item.review_class === 'exception' && <aside className="llm-advisor" aria-labelledby="llm-advisor-title">
          <div className="advisor-heading"><div><h2 id="llm-advisor-title">Советник LLM</h2><p>Задайте вопрос о маршруте или неоднозначности. LLM не утверждает и не публикует встречу.</p></div></div>
          <div className="advisor-dialogue" aria-live="polite">
            {advice.length === 0 && <p className="advisor-empty">Диалог ещё не начат.</p>}
            {advice.map((message, index) => <article className="advisor-message" key={message.id || index}>
              <div><strong>Вы</strong><p>{message.question}</p></div>
              <div><strong>Советник</strong><p>{message.answer}</p><dl><div><dt>Рекомендация</dt><dd>{message.recommended_source ? sourceLabel(message.recommended_source) : 'нет'}</dd></div><div><dt>Уверенность</dt><dd>{message.confidence}</dd></div><div><dt>Обоснование</dt><dd>{message.rationale}</dd></div></dl>{routingUnresolved && message.recommended_source && sources.some(source => source.id === message.recommended_source) && <button type="button" onClick={() => setRouteSource(message.recommended_source || '')}>Скопировать рекомендацию в выбор источника</button>}</div>
            </article>)}
          </div>
          <label htmlFor="meeting-advisor-question">Вопрос советнику<textarea id="meeting-advisor-question" rows={3} value={advisorQuestion} onChange={e => setAdvisorQuestion(e.target.value)} placeholder="Например: какой источник лучше соответствует содержанию встречи?" /></label>
          <button type="button" disabled={Boolean(busy) || !advisorQuestion.trim()} onClick={() => void askAdvisor()}>{busy === 'advisor' ? 'Советник отвечает…' : 'Спросить советника'}</button>
        </aside>}

        <div className="ai-review-tabs meeting-document-tabs" role="group" aria-label="Документ встречи">{(Object.keys(FIELD_LABELS) as DraftField[]).map(value => <button type="button" key={value} aria-pressed={field === value} disabled={!draft[value] && value !== 'canonical_markdown'} className={field === value ? 'active' : ''} onClick={() => setField(value)}>{FIELD_LABELS[value]}</button>)}</div>
        <div className="review-form"><label>{FIELD_LABELS[field]}<textarea rows={22} value={draft[field]} readOnly /></label></div>
        {detail.item.status === 'pending' && detail.item.review_class === 'exception' && <div className="review-actions"><span className="review-action-note"><strong>Исключение останавливает автоматическую публикацию.</strong> Встреча останется в истории, но не попадёт в автоматическую публикацию; потребуется указать причину.</span><button type="button" className="reject" disabled={Boolean(busy)} onClick={reject}>{busy === 'reject' ? 'Исключаем…' : 'Исключить из автопубликации'}</button></div>}
        <details className="source-context"><summary>История ({detail.revisions.length} версий / {detail.events.length} событий)</summary><pre>{JSON.stringify({ revisions: detail.revisions, events: detail.events }, null, 2)}</pre></details>
      </> : <div className="empty-state"><strong>Выберите встречу</strong><span>Причина, требуемое действие и документы появятся здесь.</span></div>}</section>
    </div>
  </div>;
}
