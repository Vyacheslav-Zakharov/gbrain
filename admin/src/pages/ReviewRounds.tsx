import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import './AIReview.css';
import './ReviewRounds.css';

type RoundStatus = 'open' | 'escalated' | 'finalizing' | 'finalized' | 'cancelled';

const STATUS_TABS: Array<{ value: RoundStatus | 'active'; label: string }> = [
  { value: 'escalated', label: 'На решении' },
  { value: 'open', label: 'Идёт голосование' },
  { value: 'finalized', label: 'Завершены' },
  { value: 'cancelled', label: 'Аннулированы' },
];

const ESCALATION_LABELS: Record<string, string> = {
  facilitator_required: 'Требуется решение фасилитатора',
  invalid_personal_reviewer_count: 'Ошибка состава проверяющих личной области',
  disagreement: 'Расхождение голосов',
  no_quorum: 'Кворум не достигнут',
  deadline_missed: 'Истёк срок голосования',
  stale_proposal: 'Предложение изменилось',
  publication_failed: 'Ошибка безопасной публикации',
  publication_interrupted: 'Публикация была прервана — требуется проверка',
  no_reviewers: 'Нет назначенных проверяющих',
};

const DECISION_LABELS: Record<string, string> = {
  approve: 'Подтвердил',
  reject: 'Отклонил',
  abstain: 'Не может оценить',
};

function finalizationLabel(round: Round): string {
  if (round.finalized_mode === 'admin_override') return ' администратором';
  if (round.finalized_mode === 'auto_quorum') return ' автоматически по кворуму';
  if (round.finalized_mode === 'auto_unanimous' && round.policy_kind === 'personal') {
    return ' владельцем личной области';
  }
  return ' единогласно';
}

interface Round {
  id: number;
  target_type: 'take_proposal' | 'concept_proposal';
  target_id: number;
  source_id: string;
  status: RoundStatus;
  outcome: 'accepted' | 'rejected' | null;
  escalation_reason: string | null;
  policy_kind: 'personal' | 'shared';
  opened_at: string;
  due_at: string;
  finalized_by: string | null;
  finalized_mode: string | null;
  final_reason: string | null;
}

interface RoundSummary {
  round: Round;
  headline: string;
  page_slug: string;
  assigned: number;
  approvals: number;
  rejections: number;
  abstentions: number;
  quorum: number | null;
  missing: string[];
}

interface MatrixEntry {
  reviewer_email: string;
  assignment_id: number;
  decision: 'approve' | 'reject' | 'abstain' | null;
  reason_code: string | null;
  comment: string | null;
  voted_at: string | null;
  details_opened: boolean;
}

interface RoundDetail extends RoundSummary {
  detail: string;
  matrix: MatrixEntry[];
  events: Array<Record<string, unknown>>;
}

const MIN_REASON_CHARS = 8;
const PAGE_SIZE = 50;

export function ReviewRoundsPage() {
  const [status, setStatus] = useState<RoundStatus | 'active'>('escalated');
  const [rounds, setRounds] = useState<RoundSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<RoundDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [showDetail, setShowDetail] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await api.reviewRounds({ status, limit: PAGE_SIZE, offset });
      setRounds(data.rounds ?? []);
      setTotal(Number(data.total ?? 0));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить раунды');
    } finally {
      setLoading(false);
    }
  }, [offset, status]);

  useEffect(() => { void load(); }, [load]);

  const open = useCallback(async (id: number) => {
    setSelected(null);
    setActionError('');
    setReason('');
    setShowDetail(true);
    try {
      setSelected(await api.reviewRound(id));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Не удалось открыть раунд');
    }
  }, []);

  const finalize = useCallback(async (action: 'accepted' | 'rejected') => {
    if (!selected) return;
    const trimmed = reason.trim();
    if (trimmed.length < MIN_REASON_CHARS) {
      setActionError(`Причина решения обязательна: не менее ${MIN_REASON_CHARS} символов.`);
      return;
    }
    setBusy(true);
    setActionError('');
    try {
      await api.reviewRoundFinalize(selected.round.id, action, trimmed);
      setSelected(null);
      setShowDetail(false);
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Не удалось завершить раунд');
    } finally {
      setBusy(false);
    }
  }, [load, reason, selected]);

  const reconcileStale = useCallback(async () => {
    if (!selected) return;
    setBusy(true);
    setActionError('');
    try {
      const result = await api.reviewRoundReconcileStale(selected.round.id) as {
        proposalStatus?: string;
        replacement?: { round?: { id?: number } } | null;
      };
      const replacementId = result.replacement?.round?.id;
      setNotice(replacementId
        ? `Старый раунд аннулирован. Для текущей редакции открыт раунд #${replacementId}.`
        : `Старый раунд аннулирован. Текущее предложение уже имеет статус «${result.proposalStatus ?? 'неизвестно'}».`);
      setSelected(null);
      setShowDetail(false);
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Не удалось закрыть устаревший раунд');
    } finally {
      setBusy(false);
    }
  }, [load, selected]);

  const canFinalize = selected?.round.status === 'escalated' && selected.round.escalation_reason !== 'stale_proposal';
  const canReconcileStale = selected?.round.status === 'escalated' && selected.round.escalation_reason === 'stale_proposal';

  return (
    <div className="ai-review">
      <div className="ai-review-header">
        <div>
          <h1>Коллективная проверка</h1>
          <p>
            В личной области решение владельца применяется автоматически. В общей области
            с тремя и более проверяющими решение принимается по строгому большинству.
            Для одного-двух проверяющих и спорных случаев требуется фасилитатор.
          </p>
          <p className="round-note">Нажмите строку, чтобы открыть голоса и действия.</p>
        </div>
        <div className="ai-review-count">
          {total === 0 ? '0 раундов' : `${offset + 1}–${Math.min(offset + rounds.length, total)} из ${total}`}
        </div>
      </div>

      <div className="ai-review-toolbar">
        <div className="ai-review-tabs">
          {STATUS_TABS.map(tab => (
            <button
              key={tab.value}
              type="button"
              className={status === tab.value ? 'active' : ''}
              onClick={() => { setStatus(tab.value); setOffset(0); setSelected(null); setShowDetail(false); }}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <button type="button" onClick={() => void load()} disabled={loading}>Обновить</button>
      </div>

      {error && <div className="ai-review-error"><span>{error}</span><button type="button" onClick={() => setError('')}>×</button></div>}
      {notice && <div className="receipt"><span>{notice}</span><button type="button" onClick={() => setNotice('')}>×</button></div>}

      <div className={`ai-review-grid ${showDetail ? 'show-detail' : ''}`}>
        <div className="proposal-list">
          {loading && <div className="empty-state"><span className="loading-spinner" aria-hidden="true" /><span>Загрузка…</span></div>}
          {!loading && rounds.length === 0 && (
            <div className="empty-state">
              <strong>Пусто</strong>
              <span>Ни один раунд не требует решения администратора.</span>
            </div>
          )}
          {rounds.map(item => (
            <button
              key={item.round.id}
              type="button"
              className={`proposal-row ${selected?.round.id === item.round.id ? 'selected' : ''}`}
              onClick={() => void open(item.round.id)}
            >
              <div className="proposal-row-top">
                <span>{item.round.target_type === 'take_proposal' ? 'Утверждение' : 'Концепция'}</span>
                <span>{item.round.source_id}</span>
              </div>
              <strong>{item.headline}</strong>
              <div className="proposal-row-meta">
                <span className="round-tally approve">за {item.approvals}</span>
                <span className="round-tally reject">против {item.rejections}</span>
                <span className="round-tally muted">не могут оценить {item.abstentions}</span>
                <span className="round-tally muted">без ответа {item.missing.length}</span>
                <span className="round-tally muted">
                  {item.quorum === null ? 'решает фасилитатор' : `кворум ${item.quorum} из ${item.assigned}`}
                </span>
                {item.round.escalation_reason && (
                  <span className="round-tally escalated">
                    {ESCALATION_LABELS[item.round.escalation_reason] || item.round.escalation_reason}
                  </span>
                )}
              </div>
            </button>
          ))}
          {total > PAGE_SIZE && (
            <div className="review-pagination" aria-label="Страницы раундов">
              <button
                type="button"
                disabled={loading || offset === 0}
                onClick={() => { setOffset(Math.max(0, offset - PAGE_SIZE)); setSelected(null); setShowDetail(false); }}
              >
                ← Назад
              </button>
              <button
                type="button"
                disabled={loading || offset + rounds.length >= total}
                onClick={() => { setOffset(offset + PAGE_SIZE); setSelected(null); setShowDetail(false); }}
              >
                Далее →
              </button>
            </div>
          )}
        </div>

        <div className="proposal-detail">
          {!selected && <div className="empty-state"><span>Выберите раунд слева.</span></div>}
          {selected && (
            <>
              <button type="button" className="mobile-back" onClick={() => setShowDetail(false)}>← К списку</button>
              <div className="detail-title">
                <div>
                  <h2>{selected.headline}</h2>
                  <code>{selected.round.source_id} / {selected.page_slug}</code>
                </div>
                <span className={`status-pill ${selected.round.status === 'finalized' ? 'accepted' : 'pending'}`}>
                  {selected.round.status === 'escalated' ? 'нужно решение' : selected.round.status}
                </span>
              </div>

              <div className="diff-card">
                <strong>Голоса проверяющих</strong>
                <table className="round-matrix">
                  <thead>
                    <tr><th>Проверяющий</th><th>Голос</th><th>Причина</th><th>Комментарий</th></tr>
                  </thead>
                  <tbody>
                    {selected.matrix.map(entry => (
                      <tr key={entry.assignment_id}>
                        <td>{entry.reviewer_email}</td>
                        <td className={entry.decision ? `vote-${entry.decision}` : 'vote-missing'}>
                          {entry.decision ? DECISION_LABELS[entry.decision] : 'Нет ответа'}
                        </td>
                        <td>{entry.reason_code || '—'}</td>
                        <td>{entry.comment || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="round-note">
                  Итог: за {selected.approvals}, против {selected.rejections}, без ответа {selected.missing.length} из {selected.assigned}.
                  Отсутствие ответа не считается отклонением.
                </p>
              </div>

              <details>
                <summary>Содержимое предложения</summary>
                <pre>{selected.detail}</pre>
              </details>

              {selected.round.status === 'finalized' && (
                <div className="receipt">
                  <strong>Решение принято</strong>
                  <p className="round-note">
                    {selected.round.outcome === 'accepted' ? 'Подтверждено' : 'Отклонено'}
                    {finalizationLabel(selected.round)}
                    {selected.round.finalized_by ? ` (${selected.round.finalized_by})` : ''}.
                  </p>
                  {selected.round.final_reason && <p className="round-note">Причина: {selected.round.final_reason}</p>}
                </div>
              )}

              {selected.round.status === 'cancelled' && (
                <div className="receipt">
                  <strong>Раунд аннулирован</strong>
                  <p className="round-note">Голоса сохранены для аудита, но не применяются к текущей редакции предложения.</p>
                </div>
              )}

              {canReconcileStale && (
                <>
                  {actionError && <div className="ai-review-inline-error"><span>{actionError}</span><button type="button" onClick={() => setActionError('')}>×</button></div>}
                  <div className="receipt">
                    <strong>Голоса относятся к старой редакции</strong>
                    <p className="round-note">
                      Принять или отклонить её нельзя. Старый раунд будет аннулирован; если предложение всё ещё ожидает проверки, для текущей редакции автоматически откроется новый раунд.
                    </p>
                  </div>
                  <div className="review-actions">
                    <button type="button" disabled={busy} onClick={() => void reconcileStale()}>
                      Закрыть старый раунд и проверить текущую редакцию
                    </button>
                  </div>
                </>
              )}

              {canFinalize && (
                <>
                  {actionError && <div className="ai-review-inline-error"><span>{actionError}</span><button type="button" onClick={() => setActionError('')}>×</button></div>}
                  <div className="llm-box">
                    <label htmlFor="round-reason">Причина решения (обязательна, минимум {MIN_REASON_CHARS} символов)</label>
                    <textarea
                      id="round-reason"
                      rows={3}
                      value={reason}
                      onChange={event => setReason(event.target.value)}
                      placeholder="Что именно проверено и почему решение отличается от голосов"
                    />
                  </div>
                  <div className="review-actions">
                    <button type="button" className="reject" disabled={busy || reason.trim().length < MIN_REASON_CHARS} onClick={() => void finalize('rejected')}>
                      Отклонить предложение
                    </button>
                    <button type="button" className="accept" disabled={busy || reason.trim().length < MIN_REASON_CHARS} onClick={() => void finalize('accepted')}>
                      Принять предложение
                    </button>
                  </div>
                </>
              )}
              {!canFinalize && selected.round.status === 'open' && (
                <p className="round-note">
                  Раунд ещё идёт. Администратор вмешивается только после расхождения или истечения срока.
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
