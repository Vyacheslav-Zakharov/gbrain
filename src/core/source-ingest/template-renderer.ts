import { createHash } from 'crypto';
import type { SourceRecord } from './connectors/types.ts';
import type { SourceIngestProfile } from './profile-schema.ts';

export interface ArticleTemplateMapping {
  frontmatter?: Record<string, string | number | boolean | null>;
  sections?: Record<string, string>;
}

export interface RenderedArticleTemplate {
  title: string;
  frontmatter: Record<string, unknown>;
  body: string;
  emptySlots: string[];
  renderedFields: Record<string, string>;
}

function valueAt(data: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let cur: unknown = data;
  for (const part of parts) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function stringifyValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(stringifyValue).filter(Boolean).join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export function slugifyTemplateValue(value: string): string {
  const map: Record<string, string> = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z', и: 'i', й: 'y',
    к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
    х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
    ә: 'a', ғ: 'g', қ: 'q', ң: 'n', ө: 'o', ұ: 'u', ү: 'u', һ: 'h', і: 'i',
  };
  return Array.from(value.toLocaleLowerCase('ru')).map(ch => map[ch] ?? ch).join('')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function renderTemplateString(template: string, record: SourceRecord, emptySlots: string[], allowedFields?: Set<string>): string {
  return template.replace(/{{\s*([^{}|]+?)(?:\s*\|\s*([A-Za-z_][A-Za-z0-9_]*))?\s*}}/g, (_m, rawField: string, filter?: string) => {
    const field = rawField.trim();
    if (allowedFields && !allowedFields.has(field)) {
      emptySlots.push(`${field} (not selected)`);
      return '';
    }
    const raw = valueAt(record.data, field);
    if (raw === undefined || raw === null || raw === '') {
      emptySlots.push(field);
      return '';
    }
    const s = stringifyValue(raw);
    if (filter && filter !== 'slugify') {
      emptySlots.push(`${field} (unknown filter: ${filter})`);
      return '';
    }
    if (filter === 'slugify') return slugifyTemplateValue(s);
    return s;
  });
}

function token(field: string, available: Set<string>): string {
  return available.has(field) ? `{{ ${field} }}` : '';
}

function firstAvailable(available: Set<string>, fields: string[]): string {
  return fields.find(f => available.has(f)) || '';
}

export function defaultEquipmentArticleTemplate(availableFields: string[] = []): ArticleTemplateMapping {
  const available = new Set(availableFields);
  const titleField = firstAvailable(available, ['name', 'title', 'code', 'id']);
  const codeField = firstAvailable(available, ['code', 'external_code', 'id']);
  const typeField = firstAvailable(available, ['vehicle_class', 'equipment_class', 'type']);
  const modelField = firstAvailable(available, ['model', 'manufacturer_model', 'name']);
  const statusField = firstAvailable(available, ['status', 'state']);
  const inventoryField = firstAvailable(available, ['external_code', 'inventory_number', 'serial_number', 'code']);
  const linkLines = [
    available.has('location_id') ? '- Находится на площадке (located_at): {{ location_id }}' : '',
    available.has('parent_id') ? '- Входит в состав узла (part_of): {{ parent_id }}' : '',
  ].filter(Boolean).join('\n');
  return {
    frontmatter: {
      type: 'equipment',
      source_id: 'shared',
      status: 'active',
      equipment_class: 'vehicle',
      aliases: '[]',
    },
    sections: {
      title: titleField ? `{{ ${titleField} }}` : '',
      summary: `${titleField ? `{{ ${titleField} }}` : 'Единица автотранспорта/оборудования группы Аверс'}${codeField ? ` — код: {{ ${codeField} }}.` : '.'}`,
      characteristics_type: token(typeField, available),
      characteristics_model: token(modelField, available),
      characteristics_status: token(statusField, available),
      characteristics_inventory: token(inventoryField, available),
      links: linkLines,
      notes: 'Данные импортированы из AppSheet. Ручные пояснения можно добавлять вне managed block.',
      timeline: '',
    },
  };
}

function mappingFromProfile(profile: SourceIngestProfile): ArticleTemplateMapping {
  const raw = profile.mapping as (SourceIngestProfile['mapping'] & { article_template?: ArticleTemplateMapping }) | undefined;
  if (raw?.article_template) return raw.article_template;
  if (profile.target.gbrain_type === 'equipment') return defaultEquipmentArticleTemplate();
  return {
    frontmatter: { type: profile.target.gbrain_type, source_id: profile.target.approved_source_id ?? 'shared', status: 'draft' },
    sections: {
      title: `{{ ${profile.identity.display_name_field} }}`,
      summary: `Source record {{ ${profile.identity.external_id_field} }}`,
      notes: 'Данные импортированы через source-ingest.',
    },
  };
}

const MAX_RENDERED_BODY_BYTES = 262_144;

function cleanLineValue(v: string): string {
  const s = v.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s || '—';
}

function capRenderedBody(body: string): string {
  if (Buffer.byteLength(body, 'utf8') <= MAX_RENDERED_BODY_BYTES) return body;
  let out = body;
  while (Buffer.byteLength(out, 'utf8') > MAX_RENDERED_BODY_BYTES - 64) out = out.slice(0, Math.max(0, out.length - 1024));
  return `${out.trimEnd()}\n\n[Preview truncated]\n`;
}

export function renderArticleTemplate(profile: SourceIngestProfile, record: SourceRecord): RenderedArticleTemplate {
  const mapping = mappingFromProfile(profile);
  const emptySlots: string[] = [];
  const renderedFields: Record<string, string> = {};
  const sections = mapping.sections || {};
  const sourceFields = Array.isArray(profile.mapping?.source_fields) ? new Set(profile.mapping.source_fields.map(String)) : undefined;
  for (const [k, tmpl] of Object.entries(sections)) {
    renderedFields[k] = renderTemplateString(String(tmpl ?? ''), record, emptySlots, sourceFields).trimEnd();
  }
  const fallbackTitle = stringifyValue(valueAt(record.data, profile.identity.display_name_field) ?? record.external_id);
  const title = cleanLineValue(renderedFields.title || fallbackTitle);
  const frontmatter: Record<string, unknown> = {
    type: profile.target.gbrain_type,
    title,
    status: 'draft',
    source_id: profile.target.approved_source_id,
    ...(profile.mapping?.frontmatter || {}),
    ...(mapping.frontmatter || {}),
  };
  frontmatter.type = profile.target.gbrain_type;
  frontmatter.title = title;
  frontmatter.source_id = profile.target.approved_source_id;

  const equipmentLayout = profile.target.gbrain_type === 'equipment' || Object.keys(sections).some(key => key.startsWith('characteristics_'));
  const sectionLabels: Record<string, string> = {
    profile: 'Профиль', participants: 'Участники', agenda: 'Повестка', decisions: 'Решения', tasks: 'Поручения',
    risks: 'Риски / открытые вопросы', open_questions: 'Открытые вопросы', links: 'Связи', notes: 'Заметки',
    source: 'Источник', ai_loop_review: 'AI-loop review', timeline: 'Timeline',
  };
  const lines = equipmentLayout ? [
    `# ${title}`,
    '',
    renderedFields.summary || '',
    '',
    '## Характеристики',
    '',
    `- Тип: ${cleanLineValue(renderedFields.characteristics_type || '')}`,
    `- Производитель/модель: ${cleanLineValue(renderedFields.characteristics_model || '')}`,
    `- Состояние: ${cleanLineValue(renderedFields.characteristics_status || '')}`,
    `- Инвентарный/серийный №: ${cleanLineValue(renderedFields.characteristics_inventory || '')}`,
    '',
    '## Связи',
    '',
    renderedFields.links || '- —',
    '',
    '## Заметки',
    '',
    renderedFields.notes || '',
    '',
    '## Timeline',
    '',
    renderedFields.timeline || '',
  ] : [
    `# ${title}`,
    '',
    renderedFields.summary || '',
    ...Object.keys(sections)
      .filter(key => key !== 'title' && key !== 'summary')
      .flatMap(key => [
        '',
        `## ${sectionLabels[key] || key.replace(/_/g, ' ').replace(/^./, ch => ch.toUpperCase())}`,
        '',
        renderedFields[key] || '',
      ]),
  ];

  const body = lines.join('\n').replace(/\n{4,}/g, '\n\n\n').trimEnd() + '\n';

  return {
    title,
    frontmatter,
    body: capRenderedBody(body),
    emptySlots: Array.from(new Set(emptySlots)),
    renderedFields,
  };
}

export function articleTemplateHash(profile: SourceIngestProfile, record: SourceRecord): string {
  const rendered = renderArticleTemplate(profile, record);
  return createHash('sha256').update(JSON.stringify({ frontmatter: rendered.frontmatter, body: rendered.body })).digest('hex');
}

export function templateFields(profile: SourceIngestProfile): string[] {
  return Object.keys(mappingFromProfile(profile).sections || {});
}
