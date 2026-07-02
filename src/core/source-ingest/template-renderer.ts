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

export function renderTemplateString(template: string, record: SourceRecord, emptySlots: string[]): string {
  return template.replace(/{{\s*([A-Za-z_][A-Za-z0-9_.]*)(?:\s*\|\s*([A-Za-z_][A-Za-z0-9_]*))?\s*}}/g, (_m, field: string, filter?: string) => {
    const raw = valueAt(record.data, field);
    if (raw === undefined || raw === null || raw === '') {
      emptySlots.push(field);
      return '';
    }
    const s = stringifyValue(raw);
    if (filter === 'slugify') return s.toLowerCase().replace(/[^a-z0-9а-яё]+/gi, '-').replace(/^-+|-+$/g, '');
    return s;
  });
}

export function defaultEquipmentArticleTemplate(): ArticleTemplateMapping {
  return {
    frontmatter: {
      type: 'equipment',
      source_id: 'shared',
      status: 'active',
      equipment_class: 'vehicle',
      aliases: '[]',
    },
    sections: {
      title: '{{ name }}',
      summary: '{{ name }} — единица автотранспорта/оборудования группы Аверс. Код: {{ code }}.',
      characteristics_type: '{{ vehicle_class }}',
      characteristics_model: '{{ model }}',
      characteristics_status: '{{ status }}',
      characteristics_inventory: '{{ external_code }}',
      links: '- Находится на площадке (located_at): {{ location_id }}\n- Входит в состав узла (part_of): {{ parent_id }}',
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

function cleanLineValue(v: string): string {
  const s = v.trim();
  return s || '—';
}

export function renderArticleTemplate(profile: SourceIngestProfile, record: SourceRecord): RenderedArticleTemplate {
  const mapping = mappingFromProfile(profile);
  const emptySlots: string[] = [];
  const renderedFields: Record<string, string> = {};
  const sections = mapping.sections || {};
  for (const [k, tmpl] of Object.entries(sections)) {
    renderedFields[k] = renderTemplateString(String(tmpl ?? ''), record, emptySlots).trimEnd();
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

  const lines = [
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
  ];

  return {
    title,
    frontmatter,
    body: lines.join('\n').replace(/\n{4,}/g, '\n\n\n').trimEnd() + '\n',
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
