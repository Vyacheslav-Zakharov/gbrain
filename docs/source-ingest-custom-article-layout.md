# Opt-in native article layout

Development/testing only. No install, publication, source/catalog writes, canonical template/schema-page changes, or native-human-preview profile changes.

## API

Add these optional fields to `mapping.article_template`:

```json
{
  "body_template": "# {{ name }}\n\n## Паспорт\n{{ passport }}\n\n## Описание\n{{ Description }}\n\n## Состав\n{{ composition }}\n",
  "typed_frontmatter": true,
  "frontmatter": { "is_group": "{{ is_group }}" }
}
```

`body_template` is the entire Markdown body, including its heading. It overrides generated section layout, not metadata. It uses existing selected-source-field/derived-linked-collection context and `slugify` support. It does not recursively interpret tokens inside source values. Source Description whitespace is preserved; the existing 262,144-byte body cap still applies. Sections can still supply the title/metadata; `include_title_heading` does not add a second heading to the explicit full body. An empty string is an explicit empty body.

`typed_frontmatter` defaults to false. Only exact, unfiltered single-token values in article-template frontmatter preserve source JSON scalar types: boolean, finite number, null, or string. No YAML parsing/coercion: source string `false` remains a string, while boolean false remains boolean false. Arrays, objects, missing values, nonfinite numbers, and unselected fields throw rather than being coerced. Mixed text and filtered tokens retain existing string interpolation. Static `mapping.frontmatter` behavior is unchanged. Reserved type/title/source_id are still forced by the normal renderer.

Do not infer units from numbers, physical absence from a leaf, or ancestors from IDs. Prepare approved type words, named ancestor chain/direct parent, and complete child code/name/type lists in selected source fields or linked collections. This renderer does not fetch or infer them. Keep provenance/SHA in metadata, not in the body template.

## Files and integration

- `src/core/source-ingest/template-renderer.ts`: existing `renderArticleTemplate` now supports full-body override and typed scalar opt-in.
- `src/core/source-ingest/profile-schema.ts`: TypeScript profile contract, runtime field validation, JSON Schema field definitions. Existing directory-guard changes preserved.
- `test/source-ingest-custom-article-layout.test.ts`: vertical renderer/preview/managed-merge coverage plus legacy bytes, scalar rejection and validation.

There is no `renderSourceRecord` symbol in this checkout. Its native equivalent is private `renderMarkdown` in `executor.ts`; it already calls the changed `renderArticleTemplate`, as does the native dry-run path. No executor edits or unused alternate renderer were introduced. Existing article-managed-block/source-managed-block, adoption frontmatter allowlist, manual notes and timeline preservation paths remain in place. Updating an existing generated article still requires the pre-existing `manage_generated_article` policy (and adoption policy where applicable).

## Verification

Observed RED for custom layout (hardcoded characteristics/notes output), then GREEN. Observed RED for typed scalar preservation and profile field rejection, then GREEN.

Command (isolated HOME, no inherited database/service credentials):

```sh
env -i HOME=$(mktemp -d) PATH=/home/avers/.bun/bin:/usr/bin:/bin \
  /home/avers/.bun/bin/bun test \
  test/source-ingest-custom-article-layout.test.ts \
  test/source-ingest-stage1.test.ts
```

Result: **14 pass, 0 fail, 109 assertions**, two files, 309 ms. `git diff --check` passed. The new fixture proves passport → literal Description → composition including multiple children, nonrecursive literal source text and blank lines, false/zero/null/string preservation, unsafe scalar rejection, native preview participation, manual-note preservation and exact legacy equipment body bytes.

Limitations: no database/executor write integration test, full suite, hosted CI or full project typecheck in this bounded task. Native executor integration is established by its existing direct call, not a database-backed execution. The managed merge fixture exercises the existing pure merge function, not a persisted adoption. No real TOiR data or preview profiles were modified. Parent should rerender approved fixtures and independently verify persisted/adopted article behavior before any publication.

Code graph lookup returned not-found/not-built; institutional query found no relevant implementation. Local source inspection established the native call sites.
