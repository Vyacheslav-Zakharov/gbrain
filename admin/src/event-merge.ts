export interface FeedEvent {
  id?: number;
  agent: string;
  operation: string;
  scopes: string;
  latency_ms: number;
  status: string;
  timestamp: string;
  params?: Record<string, unknown> | null;
  error_message?: string | null;
  error?: { code?: string; message?: string } | null;
  ui_key?: string;
}

export interface FeedErrorDiagnostic {
  title: string;
  reason: string;
  nextAction: string;
  code: string;
}

export function describeFeedError(event: FeedEvent): FeedErrorDiagnostic {
  const reason = event.error_message || event.error?.message || 'Сервис не передал текст ошибки.';
  const normalized = reason.toLowerCase();

  if (normalized.includes('page not found') || normalized.includes('page_not_found')) {
    return {
      title: 'Страница не найдена',
      reason,
      nextAction: 'Проверьте адрес страницы или найдите её через поиск.',
      code: 'page_not_found',
    };
  }
  if (normalized.includes('single source') || normalized.includes('specify source_id')) {
    return {
      title: 'Не указан источник кода',
      reason,
      nextAction: 'Повторите вызов, явно указав source_id из доступных источников.',
      code: 'source_id_required',
    };
  }
  if (normalized.includes('insufficient_scope')) {
    return {
      title: 'Недостаточно прав',
      reason,
      nextAction: 'Проверьте права агента для этой операции и источника.',
      code: 'insufficient_scope',
    };
  }
  if (normalized.includes('unknown_operation')) {
    return {
      title: 'Неизвестная операция',
      reason,
      nextAction: 'Обновите список инструментов агента и повторите запрос с актуальным именем операции.',
      code: 'unknown_operation',
    };
  }
  if (normalized.includes('timeout') || normalized.includes('timed out')) {
    return {
      title: 'Превышено время ожидания',
      reason,
      nextAction: 'Повторите запрос. Если ошибка повторяется, проверьте нагрузку и доступность сервиса.',
      code: 'timeout',
    };
  }
  if (normalized.includes('validation') || normalized.includes('invalid')) {
    return {
      title: 'Некорректные параметры',
      reason,
      nextAction: 'Проверьте обязательные поля и формат параметров запроса.',
      code: event.error?.code || 'validation_error',
    };
  }
  return {
    title: 'Ошибка выполнения',
    reason,
    nextAction: 'Откройте эту запись в Admin и проверьте техническую причину и безопасную сводку параметров.',
    code: event.error?.code || 'operation_error',
  };
}

export function formatSafeParams(params: Record<string, unknown> | null | undefined): string {
  if (!params) return 'Параметры не зафиксированы';
  if (params.redacted !== true) return 'Значения и метаданные параметров скрыты';
  const keys = Array.isArray(params.declared_keys)
    ? params.declared_keys.filter((key): key is string => typeof key === 'string')
    : [];
  const parts = [keys.length > 0 ? `Поля: ${keys.join(', ')}` : 'Поля не переданы'];
  const unknownCount = typeof params.unknown_key_count === 'number' ? params.unknown_key_count : 0;
  if (unknownCount > 0) parts.push(`неизвестных полей: ${unknownCount}`);
  if (typeof params.approx_bytes === 'number') parts.push(`размер около ${params.approx_bytes} Б`);
  return parts.join(' · ');
}

export function feedEventKey(event: FeedEvent): string {
  if (event.ui_key) return event.ui_key;
  return event.id != null
    ? `request-${event.id}`
    : `${event.timestamp}-${event.agent}-${event.operation}-${event.status}-${event.latency_ms}`;
}

function sameRequest(left: FeedEvent, right: FeedEvent): boolean {
  return left.agent === right.agent
    && left.operation === right.operation
    && left.status === right.status
    && left.latency_ms === right.latency_ms
    && Math.abs(new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime()) < 5000;
}

export function mergeEvents(current: FeedEvent[], incoming: FeedEvent[]): FeedEvent[] {
  const reservedProvisionalKeys = new Set<string>();
  const incomingWithStableKeys = incoming.map(event => {
    if (event.id == null || event.ui_key) return event;

    const existingPersisted = current.find(candidate => candidate.id === event.id);
    if (existingPersisted?.ui_key) return { ...event, ui_key: existingPersisted.ui_key };

    const provisional = current
      .filter(candidate => candidate.id == null
        && !reservedProvisionalKeys.has(feedEventKey(candidate))
        && sameRequest(candidate, event))
      .sort((left, right) => (
        Math.abs(new Date(left.timestamp).getTime() - new Date(event.timestamp).getTime())
        - Math.abs(new Date(right.timestamp).getTime() - new Date(event.timestamp).getTime())
      ))[0];
    if (!provisional) return event;

    const provisionalKey = feedEventKey(provisional);
    reservedProvisionalKeys.add(provisionalKey);
    return { ...event, ui_key: provisionalKey };
  });
  const all = [...incomingWithStableKeys, ...current];
  // Only the current polling response may reconcile provisional SSE rows.
  // Historical persisted rows already in state must never consume a fresh SSE
  // event that happens to have similar visible fields.
  const persistedIncoming = incomingWithStableKeys.filter(
    (event): event is FeedEvent & { id: number } => event.id != null,
  );
  const matchedPersistedIds = new Set<number>();
  const seen = new Set<string>();
  return all
    .filter(event => {
      if (event.id == null) {
        const eventKey = feedEventKey(event);
        const directMatch = persistedIncoming.find(candidate =>
          !matchedPersistedIds.has(candidate.id) && candidate.ui_key === eventKey,
        );
        const match = directMatch || persistedIncoming.find(candidate =>
          !matchedPersistedIds.has(candidate.id) && !candidate.ui_key && sameRequest(candidate, event),
        );
        if (match) {
          matchedPersistedIds.add(match.id);
          return false;
        }
      }
      const key = event.id != null
        ? `id:${event.id}`
        : event.ui_key
          ? `ui:${event.ui_key}`
          : `${event.timestamp}|${event.agent}|${event.operation}|${event.status}|${event.latency_ms}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, 50);
}
