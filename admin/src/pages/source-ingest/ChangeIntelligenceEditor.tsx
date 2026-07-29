import React, { useMemo } from 'react';

export type ChangeIntelligencePolicy = {
  version: 1;
  enabled: boolean;
  mode: 'current_state' | 'hybrid';
  snapshot_strategy: 'full_record';
  effective_at_field: string;
  current_state_fields_text: string;
  timeline_fields_text: string;
  relationship_rules_text: string;
  related_page_policy: 'graph_projection' | 'managed_derived_blocks' | 'agent_proposals';
  agent_enabled: boolean;
  agent_semantic_fields_text: string;
  agent_confidence_threshold: number;
  deterministic_approval: 'auto' | 'review';
  agent_approval: 'review' | 'auto_high_confidence';
  cascade_approval: 'review' | 'auto';
};

export type PersistedChangeIntelligence = {
  version: 1;
  enabled: boolean;
  mode: 'current_state' | 'hybrid';
  snapshot_strategy: 'full_record';
  effective_at_field?: string;
  current_state_fields: string[];
  timeline_fields: string[];
  relationship_rules: Array<{ field: string; link_type: string; target_type: string; target_lookup: 'external_id' | 'slug' | 'field_value' }>;
  related_pages: { policy: ChangeIntelligencePolicy['related_page_policy'] };
  agent: {
    enabled: boolean;
    semantic_fields: string[];
    confidence_threshold: number;
    allowed_actions: Array<'summary_proposal' | 'timeline_proposal' | 'related_page_proposal'>;
  };
  approval: {
    deterministic: ChangeIntelligencePolicy['deterministic_approval'];
    agent: ChangeIntelligencePolicy['agent_approval'];
    cascade: ChangeIntelligencePolicy['cascade_approval'];
  };
};

export const DEFAULT_CHANGE_INTELLIGENCE_POLICY: ChangeIntelligencePolicy = {
  version: 1,
  enabled: false,
  mode: 'hybrid',
  snapshot_strategy: 'full_record',
  effective_at_field: '',
  current_state_fields_text: '',
  timeline_fields_text: '',
  relationship_rules_text: '[]',
  related_page_policy: 'graph_projection',
  agent_enabled: false,
  agent_semantic_fields_text: '',
  agent_confidence_threshold: 0.85,
  deterministic_approval: 'auto',
  agent_approval: 'review',
  cascade_approval: 'review',
};

function lines(text: string): string[] {
  return Array.from(new Set(text.split(/[\n,]/).map(v => v.trim()).filter(Boolean)));
}

function text(values: string[]): string {
  return values.join('\n');
}

function choose(available: string[], candidates: string[]): string[] {
  const lookup = new Map(available.map(field => [field.toLowerCase(), field]));
  return candidates.map(candidate => lookup.get(candidate.toLowerCase())).filter((field): field is string => Boolean(field));
}

export function serializeChangeIntelligence(policy: ChangeIntelligencePolicy): PersistedChangeIntelligence {
  let relationships: PersistedChangeIntelligence['relationship_rules'] = [];
  try {
    const parsed = JSON.parse(policy.relationship_rules_text || '[]');
    if (Array.isArray(parsed)) relationships = parsed.filter(v => v && typeof v === 'object') as PersistedChangeIntelligence['relationship_rules'];
  } catch {}
  return {
    version: 1,
    enabled: policy.enabled,
    mode: policy.mode,
    snapshot_strategy: 'full_record',
    ...(policy.effective_at_field.trim() ? { effective_at_field: policy.effective_at_field.trim() } : {}),
    current_state_fields: lines(policy.current_state_fields_text),
    timeline_fields: lines(policy.timeline_fields_text),
    relationship_rules: relationships,
    related_pages: { policy: policy.related_page_policy },
    agent: {
      enabled: policy.agent_enabled,
      semantic_fields: lines(policy.agent_semantic_fields_text),
      confidence_threshold: Math.max(0, Math.min(1, Number(policy.agent_confidence_threshold) || 0.85)),
      allowed_actions: ['summary_proposal', 'timeline_proposal', 'related_page_proposal'],
    },
    approval: {
      deterministic: policy.deterministic_approval,
      agent: policy.agent_approval,
      cascade: policy.cascade_approval,
    },
  };
}

export function parseChangeIntelligence(raw: unknown): ChangeIntelligencePolicy {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const agent = value.agent && typeof value.agent === 'object' ? value.agent as Record<string, unknown> : {};
  const approval = value.approval && typeof value.approval === 'object' ? value.approval as Record<string, unknown> : {};
  const related = value.related_pages && typeof value.related_pages === 'object' ? value.related_pages as Record<string, unknown> : {};
  return {
    ...DEFAULT_CHANGE_INTELLIGENCE_POLICY,
    enabled: value.enabled === true,
    mode: value.mode === 'current_state' ? 'current_state' : 'hybrid',
    effective_at_field: String(value.effective_at_field ?? ''),
    current_state_fields_text: text(Array.isArray(value.current_state_fields) ? value.current_state_fields.map(String) : []),
    timeline_fields_text: text(Array.isArray(value.timeline_fields) ? value.timeline_fields.map(String) : []),
    relationship_rules_text: JSON.stringify(Array.isArray(value.relationship_rules) ? value.relationship_rules : [], null, 2),
    related_page_policy: related.policy === 'managed_derived_blocks' || related.policy === 'agent_proposals' ? related.policy : 'graph_projection',
    agent_enabled: agent.enabled === true,
    agent_semantic_fields_text: text(Array.isArray(agent.semantic_fields) ? agent.semantic_fields.map(String) : []),
    agent_confidence_threshold: Number(agent.confidence_threshold ?? 0.85),
    deterministic_approval: approval.deterministic === 'review' ? 'review' : 'auto',
    agent_approval: approval.agent === 'auto_high_confidence' ? 'auto_high_confidence' : 'review',
    cascade_approval: approval.cascade === 'auto' ? 'auto' : 'review',
  };
}

function preset(type: string, available: string[]): Partial<ChangeIntelligencePolicy> {
  const kind = type.toLowerCase();
  const employee = kind === 'person' || kind.includes('employee');
  const deal = kind.includes('deal');
  const equipment = kind.includes('equipment') || kind.includes('vehicle');
  const company = kind.includes('company');
  const position = kind.includes('position');
  const department = kind.includes('department') || kind.includes('org_unit');
  const currentCandidates = employee
    ? ['company_id', 'department_id', 'position_id', 'manager_id', 'employment_status', 'status']
    : deal
      ? ['amount', 'deal_sum', 'stage_id', 'responsible_id', 'company_id', 'next_step', 'status']
      : equipment
        ? ['status', 'location_id', 'owner_id', 'department_id', 'condition']
        : company
          ? ['name', 'full_name', 'status', 'type', 'parent_company_id', 'is_active']
          : position
            ? ['name', 'department_id', 'manager_id', 'status', 'is_active']
            : department
              ? ['name', 'parent_id', 'head_id', 'manager_id', 'status', 'is_active']
              : ['status', 'owner_id', 'updated_at'];
  const timelineCandidates = employee
    ? ['company_id', 'department_id', 'position_id', 'manager_id', 'employment_status', 'status']
    : deal
      ? ['amount', 'deal_sum', 'stage_id', 'responsible_id', 'closed_at', 'status']
      : equipment
        ? ['status', 'location_id', 'owner_id', 'department_id', 'condition']
        : company
          ? ['name', 'status', 'parent_company_id', 'is_active']
          : position
            ? ['name', 'department_id', 'status', 'is_active']
            : department
              ? ['name', 'parent_id', 'head_id', 'manager_id', 'status', 'is_active']
              : ['status'];
  const semanticCandidates = deal ? ['comment', 'comments', 'description', 'manager_note', 'next_step'] : ['comment', 'comments', 'notes', 'description'];
  const relCandidates: Array<[string, string, string]> = employee
    ? [['company_id', 'works_at', 'company'], ['department_id', 'member_of', 'org_unit'], ['position_id', 'holds_position', 'position'], ['manager_id', 'reports_to', 'person']]
    : deal
      ? [['company_id', 'deal_with', 'company'], ['responsible_id', 'owned_by', 'person']]
      : equipment
        ? [['location_id', 'located_at', 'location'], ['owner_id', 'owned_by', 'person'], ['department_id', 'assigned_to', 'org_unit']]
        : company
          ? [['parent_company_id', 'part_of', 'company']]
          : position
            ? [['department_id', 'part_of', 'org_unit']]
            : department
              ? [['parent_id', 'part_of', 'org_unit'], ['head_id', 'managed_by', 'person'], ['manager_id', 'managed_by', 'person']]
              : [];
  const availableSet = new Set(available.map(v => v.toLowerCase()));
  const relationshipRules = relCandidates
    .filter(([field]) => availableSet.has(field.toLowerCase()))
    .map(([field, link_type, target_type]) => ({ field: choose(available, [field])[0] || field, link_type, target_type, target_lookup: 'external_id' as const }));
  return {
    enabled: true,
    mode: 'hybrid',
    effective_at_field: choose(available, ['effective_from', 'changed_at', 'updated_at', 'modified_at'])[0] || '',
    current_state_fields_text: text(choose(available, currentCandidates)),
    timeline_fields_text: text(choose(available, timelineCandidates)),
    relationship_rules_text: JSON.stringify(relationshipRules, null, 2),
    agent_enabled: choose(available, semanticCandidates).length > 0,
    agent_semantic_fields_text: text(choose(available, semanticCandidates)),
    related_page_policy: 'graph_projection',
    deterministic_approval: 'auto',
    agent_approval: 'review',
    cascade_approval: 'review',
  };
}

export function ChangeIntelligenceEditor({ policy, setPolicy, availableFields, gbrainType, invalidate }: {
  policy: ChangeIntelligencePolicy;
  setPolicy: React.Dispatch<React.SetStateAction<ChangeIntelligencePolicy>>;
  availableFields: string[];
  gbrainType: string;
  invalidate: () => void;
}) {
  const serialized = useMemo(() => serializeChangeIntelligence(policy), [policy]);
  const update = (patch: Partial<ChangeIntelligencePolicy>) => { setPolicy(prev => ({ ...prev, ...patch })); invalidate(); };
  let relationshipsValid = true;
  try { relationshipsValid = Array.isArray(JSON.parse(policy.relationship_rules_text || '[]')); } catch { relationshipsValid = false; }
  const readiness = [
    policy.enabled ? null : 'отслеживание выключено',
    policy.enabled && !policy.effective_at_field ? 'дата изменения берётся из updated_at источника или времени обнаружения' : null,
    policy.enabled && lines(policy.current_state_fields_text).length === 0 ? 'не выбраны поля текущего состояния' : null,
    policy.enabled && policy.mode === 'hybrid' && lines(policy.timeline_fields_text).length === 0 ? 'не выбраны поля Timeline' : null,
    relationshipsValid ? null : 'некорректный JSON правил связей',
  ].filter(Boolean) as string[];

  return <section style={{ marginTop: 14, border: '1px solid var(--border)', borderRadius: 10, padding: 14, background: 'rgba(15,23,42,0.34)' }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      <div>
        <h3 style={{ margin: 0, fontSize: 15 }}>История изменений (Change Intelligence)</h3>
        <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 4, maxWidth: 820 }}>
          Контракт: снимки источника → детерминированное сравнение полей → текущее состояние, Timeline и граф → необязательные предложения агента. Сохранение фиксирует политику для следующего этапа executor, но само не включает изменения данных.
        </div>
      </div>
      <button type="button" className="btn btn-secondary" onClick={() => update(preset(gbrainType, availableFields))}>Применить рекомендуемый шаблон для {gbrainType || 'типа'}</button>
    </div>

    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 14 }}>
      <label style={{ gridColumn: '1 / -1' }}><input type="checkbox" checked={policy.enabled} onChange={e => update({ enabled: e.target.checked })} style={{ marginRight: 8 }} />Включить отслеживание изменений</label>
      <label>Режим<select value={policy.mode} onChange={e => update({ mode: e.target.value === 'current_state' ? 'current_state' : 'hybrid' })}><option value="hybrid">гибрид: текущее состояние + история</option><option value="current_state">только текущее состояние</option></select></label>
      <label>Поле даты изменения<select value={policy.effective_at_field} onChange={e => update({ effective_at_field: e.target.value })}><option value="">Использовать updated_at источника или detected_at</option>{availableFields.map(field => <option key={field} value={field}>{field}</option>)}</select></label>
      <label>Поля текущего состояния<textarea rows={7} value={policy.current_state_fields_text} onChange={e => update({ current_state_fields_text: e.target.value })} placeholder={'status\nposition_id\ndepartment_id'} style={{ width: '100%', fontFamily: 'var(--font-mono)', fontSize: 12 }} /><span style={{ color: 'var(--text-muted)', fontSize: 11 }}>Новые значения заменяют только проекцию, управляемую источником.</span></label>
      <label>Поля Timeline<textarea rows={7} value={policy.timeline_fields_text} onChange={e => update({ timeline_fields_text: e.target.value })} placeholder={'position_id\ndepartment_id\nstatus'} style={{ width: '100%', fontFamily: 'var(--font-mono)', fontSize: 12 }} /><span style={{ color: 'var(--text-muted)', fontSize: 11 }}>Изменение значения становится неизменяемым бизнес-событием.</span></label>
      <label style={{ gridColumn: '1 / -1' }}>JSON правил связей<textarea rows={8} value={policy.relationship_rules_text} onChange={e => update({ relationship_rules_text: e.target.value })} style={{ width: '100%', fontFamily: 'var(--font-mono)', fontSize: 12, borderColor: relationshipsValid ? undefined : 'var(--error)' }} /><span style={{ color: relationshipsValid ? 'var(--text-muted)' : 'var(--error)', fontSize: 11 }}>{relationshipsValid ? 'Текущий граф — проекция; история сохраняется в событиях и снимках.' : 'Некорректный JSON-массив.'}</span></label>
      <label>Связанные страницы<select value={policy.related_page_policy} onChange={e => update({ related_page_policy: e.target.value as ChangeIntelligencePolicy['related_page_policy'] })}><option value="graph_projection">Только проекция графа (рекомендуется)</option><option value="managed_derived_blocks">Обновлять управляемые производные блоки</option><option value="agent_proposals">Только предложения агента</option></select></label>
      <label>Детерминированные изменения<select value={policy.deterministic_approval} onChange={e => update({ deterministic_approval: e.target.value === 'review' ? 'review' : 'auto' })}><option value="auto">Применять автоматически</option><option value="review">Требовать проверки</option></select></label>
    </div>

    <div style={{ marginTop: 14, border: '1px solid var(--border)', borderRadius: 8, padding: 12 }}>
      <label><input type="checkbox" checked={policy.agent_enabled} onChange={e => update({ agent_enabled: e.target.checked })} style={{ marginRight: 8 }} />Агент анализирует смысловые текстовые поля</label>
      <div style={{ color: 'var(--text-muted)', fontSize: 12, margin: '5px 0 10px' }}>Агент может предлагать изменения сводки, Timeline и связанных страниц, но не редактирует Markdown напрямую.</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
        <label>Смысловые поля<textarea rows={5} value={policy.agent_semantic_fields_text} onChange={e => update({ agent_semantic_fields_text: e.target.value })} placeholder={'comment\nmanager_note\ndescription'} style={{ width: '100%', fontFamily: 'var(--font-mono)', fontSize: 12 }} /></label>
        <label>Порог уверенности<input type="number" min="0" max="1" step="0.05" value={policy.agent_confidence_threshold} onChange={e => update({ agent_confidence_threshold: Number(e.target.value) })} /><span style={{ color: 'var(--text-muted)', fontSize: 11 }}>Ниже порога — ручная проверка или отсутствие предложения.</span></label>
        <label>Предложения агента<select value={policy.agent_approval} onChange={e => update({ agent_approval: e.target.value === 'auto_high_confidence' ? 'auto_high_confidence' : 'review' })}><option value="review">Всегда требовать проверки</option><option value="auto_high_confidence">Автоматически только выше порога</option></select><label style={{ marginTop: 10 }}><input type="checkbox" checked={policy.cascade_approval === 'review'} onChange={e => update({ cascade_approval: e.target.checked ? 'review' : 'auto' })} style={{ marginRight: 8 }} />Проверять изменения соседних страниц</label></label>
      </div>
    </div>

    <div style={{ marginTop: 14, padding: 10, borderRadius: 8, background: readiness.length ? 'rgba(245,158,11,0.10)' : 'rgba(34,197,94,0.10)', color: readiness.length ? 'var(--warning)' : 'var(--success)' }}>
      <strong>{readiness.length ? 'Политика требует внимания' : 'Политика готова'}</strong>{readiness.length > 0 && <ul style={{ margin: '6px 0 0 18px' }}>{readiness.map(item => <li key={item}>{item}</li>)}</ul>}
    </div>
    <details style={{ marginTop: 12 }}><summary style={{ cursor: 'pointer' }}>Сохранённый контракт</summary><pre style={{ maxHeight: 360, overflow: 'auto', fontSize: 11 }}>{JSON.stringify(serialized, null, 2)}</pre></details>
  </section>;
}
