/** Validated process-global PostgreSQL text-search configuration. */
const VALID_CONFIG_NAME = /^[a-z][a-z0-9_]*$/;
const DEFAULT_LANGUAGE = 'english';
let cachedLanguage: string | null = null;

export function getFtsLanguage(): string {
  if (cachedLanguage !== null) return cachedLanguage;
  const raw = process.env.GBRAIN_FTS_LANGUAGE?.trim();
  if (!raw) return (cachedLanguage = DEFAULT_LANGUAGE);
  if (!VALID_CONFIG_NAME.test(raw)) {
    console.warn(`[gbrain] Invalid GBRAIN_FTS_LANGUAGE='${raw}' — falling back to '${DEFAULT_LANGUAGE}'.`);
    return (cachedLanguage = DEFAULT_LANGUAGE);
  }
  return (cachedLanguage = raw);
}

export function resetFtsLanguageCache(): void {
  cachedLanguage = null;
}

export function applyFtsLanguagePolicy(sql: string): string {
  const language = getFtsLanguage();
  if (language === DEFAULT_LANGUAGE) return sql;
  return sql.replaceAll(`to_tsvector('${DEFAULT_LANGUAGE}',`, `to_tsvector('${language}',`);
}

export function buildFtsTriggerFunctionsSql(language: string): string {
  if (!VALID_CONFIG_NAME.test(language)) throw new Error(`Invalid FTS language: ${language}`);
  return `
CREATE OR REPLACE FUNCTION update_page_search_vector() RETURNS trigger
SET search_path = pg_catalog, public AS $fn$
DECLARE timeline_text TEXT;
BEGIN
  SELECT coalesce(string_agg(summary || ' ' || detail, ' '), '') INTO timeline_text
  FROM timeline_entries WHERE page_id = NEW.id;
  NEW.search_vector :=
    setweight(to_tsvector('${language}', coalesce(NEW.title, '')), 'A') ||
    setweight(to_tsvector('${language}', coalesce(NEW.compiled_truth, '')), 'B') ||
    setweight(to_tsvector('${language}', coalesce(NEW.timeline, '')), 'C') ||
    setweight(to_tsvector('${language}', coalesce(timeline_text, '')), 'C');
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION update_chunk_search_vector() RETURNS trigger
SET search_path = pg_catalog, public AS $fn$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('${language}', COALESCE(NEW.doc_comment, '')), 'A') ||
    setweight(to_tsvector('${language}', COALESCE(NEW.symbol_name_qualified, '')), 'A') ||
    setweight(to_tsvector('${language}', COALESCE(NEW.chunk_text, '')), 'B');
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;`;
}
