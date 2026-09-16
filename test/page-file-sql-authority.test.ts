import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as authority from '../src/core/page-file-sql-authority.ts';
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const base = { database: 'fixture', role: 'ordinary', roles: {
  ordinary: 'ordinary', adapter: 'adapter', enrollment: 'enrollment',
}, catalogPins: {} as Record<string,string> };
const denied = { ok: false, code: 'page_file_sql_authority_invalid' } as const;
function fixture(role = 'ordinary') {
  const expected = { ...base, role, catalogPins: {} as Record<string,string> };
  const queries = authority.pageFileSqlAuthorityQueries(expected);
  const rows = queries.map(q => {
    if (q.catalog) expected.catalogPins[q.id] = digest('reviewed fixture definition');
    return { id: q.id, ok: true, ...(q.catalog ? { definition: 'reviewed fixture definition' } : {}) };
  });
  return { expected, rows, queries };
}
test('missing authority evidence fails closed with static diagnostic', () => {
  expect(authority.validatePageFileSqlAuthority([], base)).toEqual(denied);
});
test('all three distinct fixture principals satisfy their exact evidence contract', () => {
  for (const role of Object.values(base.roles)) {
    const { rows, expected } = fixture(role);
    expect(authority.validatePageFileSqlAuthority(rows, expected)).toEqual({ ok: true });
  }
});
test('every missing, duplicate, false or untyped evidence row denies', () => {
  const { rows, expected } = fixture();
  for (let i = 0; i < rows.length; i++) {
    expect(authority.validatePageFileSqlAuthority(rows.filter((_, j) => i !== j), expected)).toEqual(denied);
    expect(authority.validatePageFileSqlAuthority([...rows, rows[i]], expected)).toEqual(denied);
    for (const ok of [false, null, undefined, 'true', 1]) {
      const changed: unknown[] = [...rows]; changed[i] = { ...rows[i], ok };
      expect(authority.validatePageFileSqlAuthority(changed, expected)).toEqual(denied);
    }
  }
});
test('catalog pin absent or drifted denies even with affirmative catalog checks', () => {
  const { rows, expected } = fixture('adapter');
  for (const row of rows.filter(r => r.definition)) {
    expect(authority.validatePageFileSqlAuthority(rows, { ...expected, catalogPins: { ...expected.catalogPins, [row.id]: digest('drift') } })).toEqual(denied);
    const pins = { ...expected.catalogPins }; delete pins[row.id];
    expect(authority.validatePageFileSqlAuthority(rows, { ...expected, catalogPins: pins })).toEqual(denied);
  }
});
test('invalid principal contract and arbitrary rows never leak supplied secrets', () => {
  const { rows, expected } = fixture();
  for (const e of [{ ...expected, role: 'postgres://secret' }, { ...expected, database: '' },
    { ...expected, roles: { ...expected.roles, adapter: expected.roles.ordinary } }]) {
    expect(authority.validatePageFileSqlAuthority(rows, e)).toEqual(denied);
  }
  expect(authority.validatePageFileSqlAuthority([{ secret: 'password' }], expected)).toEqual(denied);
});
test('collector runs only SELECT catalog probes and sanitizes driver failures', async () => {
  const { expected, rows, queries } = fixture(); let index = 0;
  expect(await authority.verifyPageFileSqlAuthority(async (sql, params) => {
    expect(sql.trimStart().startsWith('SELECT')).toBe(true);
    expect(params).toEqual([expected.role, expected.database]);
    return [rows[index++]];
  }, expected)).toEqual({ ok: true });
  expect(index).toBe(queries.length);
  expect(await authority.verifyPageFileSqlAuthority(async () => { throw new Error('postgres://user:secret@host'); }, expected)).toEqual(denied);
});
test('SQL covers effective column grants, grant options, membership, catalog and RLS, not ACL text alone', () => {
  const { queries } = fixture('adapter'); const sql = queries.map(q => q.sql).join('\n');
  for (const token of ['has_column_privilege', 'WITH GRANT OPTION', 'pg_auth_members', 'row_security_active',
    'pg_get_functiondef', 'pg_get_triggerdef', 'pg_policy', 'rolreplication', 'relowner', 'session_user']) expect(sql).toContain(token);
  expect(sql).not.toContain('SET ROLE');
  expect(sql).not.toContain('GRANT SELECT');
  for (const q of queries) { expect(q.sql).toContain('$1'); expect(q.sql).toContain('$2'); }
  expect(sql).toContain('has_parameter_privilege');
});

test('mixed ordinary writer retains finite legacy DML without capability or binding authority', () => {
  const { queries } = fixture('ordinary');
  const sql = (table: string) => queries.find(q => q.id === `table:${table}`)!.sql;
  for (const table of ['sources','pages','config','tags','timeline_entries','content_chunks','page_versions','code_edges_chunk','code_edges_symbol']) {
    for (const privilege of ['SELECT','INSERT','UPDATE','DELETE'])
      expect(sql(table)).toContain(`has_table_privilege($1,c.oid,'${privilege}')=true`);
  }
  for (const table of ['page_file_bindings','page_file_operations','page_file_write_authorizations']) {
    for (const privilege of ['INSERT','UPDATE','DELETE','TRUNCATE','TRIGGER','REFERENCES'])
      expect(sql(table)).toContain(`has_table_privilege($1,c.oid,'${privilege}')=false`);
  }
  expect(queries.some(q => q.id === 'sequence:pages')).toBe(true);
  for (const query of queries.filter(q => q.id.startsWith('sequence:'))) {
    expect(query.sql).toContain("has_sequence_privilege($1,c.oid,'USAGE')=true");
    expect(query.sql).toContain("has_sequence_privilege($1,c.oid,'UPDATE')=false");
  }
  expect(sql('pages')).toContain('aa_file_page_write_fence');
  expect(sql('content_chunks')).toContain('aa_file_chunk_write_fence');
});

test('role matrix preserves hosted table versus column-only grants', () => {
  const sql = (role: string, table: string) => fixture(role).queries.find(q => q.id === `table:${table}`)!.sql;
  expect(sql('ordinary', 'page_file_write_authorizations')).toContain("has_table_privilege($1,c.oid,'INSERT')=false");
  expect(sql('adapter', 'page_file_write_authorizations')).toContain("has_table_privilege($1,c.oid,'INSERT')=true");
  expect(sql('enrollment', 'page_file_write_authorizations')).toContain("has_table_privilege($1,c.oid,'INSERT')=false");
  expect(sql('adapter', 'page_file_bindings')).toContain("has_table_privilege($1,c.oid,'UPDATE')=false");
  expect(sql('adapter', 'page_file_bindings')).toContain("ARRAY['pending_op_id','indexed_raw_sha256','file_generation']");
  expect(sql('enrollment', 'pages')).toContain("has_table_privilege($1,c.oid,'UPDATE')=false");
  expect(sql('enrollment', 'pages')).toContain("ARRAY['id']");
  expect(sql('enrollment', 'page_file_bindings')).toContain("has_table_privilege($1,c.oid,'INSERT')=true");
});
