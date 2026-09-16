import { createHash } from 'node:crypto';

/** Read-only companion to page-file-authority.ts; deliberately NOT wired into
 * runtime admission. Privileges mirror the hosted runtime authority fixture.
 * Pins must originate in an independently reviewed, protected provisioning
 * manifest, never be learned from the same database being admitted. */
export interface PageFileSqlAuthorityExpectation {
  database: string;
  role: string;
  roles: { ordinary: string; adapter: string; enrollment: string };
  catalogPins: Record<string, string>;
}
export interface AuthorityProbe { id: string; sql: string; catalog?: boolean }
export interface AuthorityEvidence { id: string; ok: boolean; definition?: string }
export type AuthorityVerdict = { ok: true } | { ok: false; code: 'page_file_sql_authority_invalid' };
const denied = (): AuthorityVerdict => ({ ok: false, code: 'page_file_sql_authority_invalid' });
const tables = ['sources', 'pages', 'page_file_bindings', 'config', 'tags', 'timeline_entries',
  'content_chunks', 'page_versions', 'page_file_operations', 'page_file_write_authorizations',
  'code_edges_chunk', 'code_edges_symbol'] as const;
const triggers: Record<string, string[]> = {
  sources: ['aa_file_source_write_fence'], config: ['aa_file_config_write_fence'],
  pages: ['aa_file_page_write_fence', 'page_write_revision_trg', 'bump_page_generation_trg', 'bump_page_generation_clock_trg'],
  tags: ['tag_page_write_revision_trg'], content_chunks: ['aa_file_chunk_write_fence'],
};
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
function kind(expected: PageFileSqlAuthorityExpectation) {
  const roles = Object.values(expected.roles);
  if (!expected.database || roles.length !== 3 || roles.some(r => typeof r !== 'string' || !r)
    || new Set(roles).size !== 3) throw new Error('invalid');
  const k = (Object.keys(expected.roles) as (keyof typeof expected.roles)[]).find(k => expected.roles[k] === expected.role);
  if (!k) throw new Error('invalid');
  return k;
}
/** Every query is a SELECT, with actual login/database bound as $1/$2.
 * Call on ONE reserved physical session, in a caller-owned read-only repeatable
 * read transaction. No driver, credentials, SET ROLE, DDL or business data here. */
export function pageFileSqlAuthorityQueries(expected: PageFileSqlAuthorityExpectation): AuthorityProbe[] {
  const principal = kind(expected);
  const adapter = principal === 'adapter', enrollment = principal === 'enrollment';
  const probes: AuthorityProbe[] = [];
  const add = (id: string, expression: string, from = '') => probes.push({ id,
    sql: `SELECT ${literal(id)} AS id, (current_database()=$2 AND (${expression})) AS ok ${from}` });
  add('identity', `session_user::text=$1 AND current_user::text=$1 AND current_database()=$2
    AND rolcanlogin AND NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls OR rolreplication)
    AND NOT rolinherit AND current_setting('session_replication_role')='origin'
    AND current_setting('row_security')='on'`, 'FROM pg_catalog.pg_roles WHERE rolname=current_user');
  // Reject ALL membership edges (including NOINHERIT/SET-only/admin-option).
  // Thus no direct edge can lead to an indirect escalating role on PG14–17.
  add('membership', `NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m
    JOIN pg_catalog.pg_roles r ON r.oid=m.member WHERE r.rolname=$1)`);
  add('replication-setting', `NOT has_parameter_privilege($1,'session_replication_role','SET')
    AND NOT has_parameter_privilege($1,'session_replication_role','ALTER SYSTEM')`);
  add('namespace', `NOT has_database_privilege($1,current_database(),'CREATE')
    AND NOT has_schema_privilege($1,'public','CREATE') AND has_schema_privilege($1,'public','USAGE')
    AND has_database_privilege($1,current_database(),'CONNECT')
    AND d.datdba<>r.oid AND n.nspowner<>r.oid`,
    `FROM pg_catalog.pg_database d CROSS JOIN pg_catalog.pg_namespace n CROSS JOIN pg_catalog.pg_roles r
     WHERE d.datname=current_database() AND n.nspname='public' AND r.rolname=$1`);
  for (const table of tables) {
    const grants = new Set<string>();
    if (['sources','pages','page_file_bindings','config'].includes(table)) grants.add('SELECT');
    if ((adapter && ['tags','timeline_entries','code_edges_chunk','code_edges_symbol'].includes(table))
      || (enrollment && table === 'tags')) grants.add('SELECT');
    // Ordinary legacy writes coexist with enrolled pages: DB fences, not a
    // read-only application login, protect enrolled identity/body/chunks/roots.
    // Never grant ordinary access to mutation capabilities or binding lifecycle.
    if (principal === 'ordinary' && !['page_file_bindings','page_file_operations','page_file_write_authorizations'].includes(table)) {
      for (const g of ['SELECT','INSERT','UPDATE','DELETE']) grants.add(g);
    }
    if (adapter) {
      if (table === 'pages') grants.add('UPDATE');
      const extras: Record<string,string[]> = {
        content_chunks: ['SELECT','INSERT','UPDATE','DELETE'], page_versions: ['SELECT','INSERT'],
        page_file_operations: ['SELECT','INSERT','UPDATE'], page_file_write_authorizations: ['SELECT','INSERT','DELETE'],
      };
      for (const g of extras[table] ?? []) grants.add(g);
    }
    if (enrollment && table === 'page_file_bindings') grants.add('INSERT');
    const updateColumns = adapter && table === 'page_file_bindings' ? ['pending_op_id','indexed_raw_sha256','file_generation']
      : ((adapter || enrollment) && table === 'sources') || (enrollment && table === 'pages') ? ['id'] : [];
    const relation = `public.${table}`;
    const checks = ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'].flatMap(p => [
      `has_table_privilege($1,c.oid,'${p}')=${grants.has(p)}`,
      `NOT has_table_privilege($1,c.oid,'${p} WITH GRANT OPTION')`,
    ]);
    // has_column_privilege includes PUBLIC, inherited and table-level grants.
    // Enumerate ALL columns of these finite relations, not the whole database.
    checks.push(`NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a
      CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('REFERENCES')) p(priv)
      WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped AND (
        has_column_privilege($1,c.oid,a.attnum,p.priv) IS DISTINCT FROM
          (p.priv=ANY(ARRAY[${[...grants].map(literal).join(',')}]::text[])
           OR (p.priv='UPDATE' AND a.attname=ANY(ARRAY[${updateColumns.map(literal).join(',')}]::text[])))
        OR has_column_privilege($1,c.oid,a.attnum,p.priv || ' WITH GRANT OPTION')))`);
    for (const col of updateColumns) checks.push(`EXISTS(SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid=c.oid AND attname=${literal(col)} AND attnum>0 AND NOT attisdropped)`);
    checks.push(`c.relkind='r'`, `c.relowner<>r.oid`, `c.relrowsecurity`, `row_security_active(c.oid)`);
    // Membership is independently denied, so owner equality cannot be hidden
    // behind owner-role inheritance. Require named fences on their exact tables.
    for (const trigger of triggers[table] ?? []) checks.push(`EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t
      WHERE t.tgrelid=c.oid AND t.tgname=${literal(trigger)} AND NOT t.tgisinternal AND t.tgenabled IN ('O','A'))`);
    checks.push(`NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
      WHERE t.tgrelid=c.oid AND NOT t.tgisinternal AND p.proowner=r.oid)`);
    add(`table:${table}`, checks.join(' AND '), `FROM pg_catalog.pg_class c CROSS JOIN pg_catalog.pg_roles r
      WHERE c.oid=to_regclass('${relation}') AND r.rolname=$1`);
    const id = `catalog:${table}`;
    // Exact reviewed definition covers columns/defaults, constraints, every
    // policy (including extra permissive policies), trigger enablement/function
    // identity/body/security/search_path, owners, and RLS/FORCE flags.
    probes.push({ id, catalog: true, sql: `SELECT '${id}' AS id, true AS ok,
      jsonb_build_object('owner',pg_get_userbyid(c.relowner),'rls',c.relrowsecurity,'force',c.relforcerowsecurity,
      'columns',(SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,
        pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum) FROM pg_catalog.pg_attribute a
        LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
        WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
      'constraints',(SELECT jsonb_agg(jsonb_build_array(k.conname,k.convalidated,pg_get_constraintdef(k.oid)) ORDER BY k.conname)
        FROM pg_catalog.pg_constraint k WHERE k.conrelid=c.oid),
      'policies',(SELECT jsonb_agg(jsonb_build_array(p.polname,p.polcmd,p.polpermissive,
        (SELECT jsonb_agg(CASE WHEN x=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x) END ORDER BY x) FROM unnest(p.polroles) x),
        pg_get_expr(p.polqual,p.polrelid),pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY p.polname)
        FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid),
      'triggers',(SELECT jsonb_agg(jsonb_build_array(t.tgname,t.tgenabled,pg_get_triggerdef(t.oid),
        pg_get_userbyid(f.proowner),f.prosecdef,f.proconfig,pg_get_functiondef(f.oid)) ORDER BY t.tgname)
        FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_proc f ON f.oid=t.tgfoid
        WHERE t.tgrelid=c.oid AND NOT t.tgisinternal))::text AS definition
      FROM pg_catalog.pg_class c WHERE c.oid=to_regclass('${relation}') AND current_user::text=$1 AND current_database()=$2` });
  }
  for (const sequence of ['page_generation_clock_seq','content_chunks','page_versions','timeline_entries',
    'pages','tags','code_edges_chunk','code_edges_symbol']) {
    const oid = sequence.endsWith('_seq') ? `to_regclass('public.${sequence}')` : `to_regclass(pg_get_serial_sequence('public.${sequence}','id'))`;
    const privileges = ['USAGE','SELECT','UPDATE'].flatMap(p => [
      `has_sequence_privilege($1,c.oid,'${p}')=${(principal === 'ordinary' || (adapter && !['pages','tags','code_edges_chunk','code_edges_symbol'].includes(sequence))) && (p === 'USAGE' || (p === 'SELECT' && !sequence.endsWith('_seq')))}`,
      `NOT has_sequence_privilege($1,c.oid,'${p} WITH GRANT OPTION')`,
    ]);
    add(`sequence:${sequence}`, `c.relkind='S' AND c.relowner<>r.oid AND ${privileges.join(' AND ')}`,
      `FROM pg_catalog.pg_class c CROSS JOIN pg_catalog.pg_roles r WHERE c.oid=${oid} AND r.rolname=$1`);
  }
  return probes;
}

/** No evidence/identity/SQL/error text is reflected into diagnostics. */
export function validatePageFileSqlAuthority(rows: unknown, expected: PageFileSqlAuthorityExpectation): AuthorityVerdict {
  try {
    const probes = pageFileSqlAuthorityQueries(expected);
    if (!Array.isArray(rows) || rows.length !== probes.length) return denied();
    const byId = new Map<string, AuthorityEvidence>();
    for (const row of rows) {
      if (!row || typeof row.id !== 'string' || row.ok !== true || byId.has(row.id)) return denied();
      byId.set(row.id, row);
    }
    for (const probe of probes) {
      const row = byId.get(probe.id);
      if (!row) return denied();
      if (probe.catalog) {
        const pin = expected.catalogPins[probe.id];
        if (!/^[a-f0-9]{64}$/.test(pin ?? '') || typeof row.definition !== 'string'
          || createHash('sha256').update(row.definition).digest('hex') !== pin) return denied();
      }
    }
    return { ok: true };
  } catch { return denied(); }
}
export async function verifyPageFileSqlAuthority(
  query: (sql: string, parameters: string[]) => Promise<unknown[]>,
  expected: PageFileSqlAuthorityExpectation,
): Promise<AuthorityVerdict> {
  try {
    const captured = structuredClone(expected);
    const rows: unknown[] = [];
    for (const probe of pageFileSqlAuthorityQueries(captured)) rows.push(...await query(probe.sql, [captured.role, captured.database]));
    return validatePageFileSqlAuthority(rows, captured);
  } catch { return denied(); }
}
