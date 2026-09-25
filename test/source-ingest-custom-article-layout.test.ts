import { expect, test } from 'bun:test';
import { renderArticleTemplate } from '../src/core/source-ingest/template-renderer.ts';
import { buildSourceDryRun } from '../src/core/source-ingest/dry-run.ts';
import { mergeManagedBlock } from '../src/core/source-ingest/managed-block.ts';
import { validateSourceIngestProfile, sourceIngestProfileJsonSchema, type SourceIngestProfile } from '../src/core/source-ingest/profile-schema.ts';

const profile: SourceIngestProfile = {
  profile_id: 'layout-test', status: 'reviewed', source_connector: 'fake-source', source_object: 'equipment',
  target: { gbrain_type: 'equipment', approved_source_id: 'shared', slug_template: 'equipment/{{ id }}' },
  identity: { external_id_field: 'id', display_name_field: 'name' },
  update_policy: { mode: 'managed_block', preserve_manual_sections: true, field_allowlist: [] },
  security: { classification: 'shared', pii: false },
};
const description = 'Полное описание: 12 без выдуманных единиц.\n\n\n\nВторая строка {{ untouched }}.';
const record = { external_id: 'one', data: { id: 'one', name: 'Насос', Description: description, passport: 'Тип: насос\nПлощадка → Цех → Узел; родитель: Узел', children: '- C1 / Клапан / арматура\n- C2 / Привод / двигатель' } };
const bodyTemplate = '# {{ name }}\n\n## Паспорт\n{{ passport }}\n\n## Описание\n{{ Description }}\n\n## Состав\n{{ children }}\n';

test('legacy equipment rendering is byte unchanged with explicit opt-out', () => {
  const legacy = { ...profile, mapping: { article_template: { sections: { title: '{{ name }}' }, typed_frontmatter: false } } };
  expect(renderArticleTemplate(legacy, record).body).toBe('# Насос\n\n\n## Характеристики\n\n- Тип: —\n- Производитель/модель: —\n- Состояние: —\n- Инвентарный/серийный №: —\n\n## Связи\n\n- —\n\n## Заметки\n\n\n## Timeline\n');
  delete (legacy.mapping.article_template as { typed_frontmatter?: boolean }).typed_frontmatter;
  const omitted = renderArticleTemplate(legacy, record);
  expect(omitted).toEqual(renderArticleTemplate({ ...legacy, mapping: { article_template: { ...legacy.mapping.article_template, typed_frontmatter: false } } }, record));
});

test('typed scalar frontmatter is opt-in and rejects non-scalars', () => {
  const typed = { ...profile, mapping: { article_template: { typed_frontmatter: true, frontmatter: { flag: '{{ flag }}', count: '{{ count }}', nil: '{{ nil }}', text: '{{ text }}' } } } } as SourceIngestProfile;
  const data = { ...record.data, flag: false, count: 0, nil: null, text: 'false' };
  expect(renderArticleTemplate(typed, { ...record, data }).frontmatter).toMatchObject({ flag: false, count: 0, nil: null, text: 'false' });
  for (const flag of [{ nested: true }, [], undefined, NaN, Infinity]) {
    expect(() => renderArticleTemplate(typed, { ...record, data: { ...data, flag } })).toThrow('scalar');
  }
  const legacy = structuredClone(typed);
  delete legacy.mapping!.article_template!.typed_frontmatter;
  expect(renderArticleTemplate(legacy, { ...record, data }).frontmatter.flag).toBe('false');
});

test('new profile fields have strict runtime and JSON schema contracts', () => {
  for (const article_template of [{ body_template: 3 }, { body_template: null }, { typed_frontmatter: 'false' }, { typed_frontmatter: null }]) {
    expect(validateSourceIngestProfile({ ...profile, mapping: { article_template } }).ok).toBe(false);
  }
  const schema: any = sourceIngestProfileJsonSchema();
  expect(schema.properties.mapping.properties.article_template.properties.body_template.type).toBe('string');
  expect(schema.properties.mapping.properties.article_template.properties.typed_frontmatter.type).toBe('boolean');
});

test('custom full body flows through native preview and managed merge without losing literal Description', () => {
  const custom = { ...profile, mapping: { article_template: { body_template: bodyTemplate } } } as SourceIngestProfile;
  const article = renderArticleTemplate(custom, record);
  expect(article.body).toBe(bodyTemplate.replace('{{ name }}', 'Насос').replace('{{ passport }}', record.data.passport).replace('{{ Description }}', description).replace('{{ children }}', record.data.children));
  const preview = buildSourceDryRun(custom, [record]);
  expect(JSON.stringify(preview)).toContain('## Паспорт');
  const merged = mergeManagedBlock('Manual notes stay.\n', profile.profile_id, 'one', article.body);
  expect(merged.content).toContain('Manual notes stay.');
  expect(merged.content).toContain(description);
  expect(merged.content).toContain('gbrain-source-sync:start');
});
