import { expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

// Execute the actual connected fixture's teardown, not a parallel SQL recipe.
const source = readFileSync(new URL('./e2e/helpers/page-file-connected-bootstrap.ts', import.meta.url), 'utf8');
const teardown = source.slice(source.lastIndexOf('  } finally {') + '  } finally {'.length, source.lastIndexOf('\n  }\n}'));
const catchStart = source.lastIndexOf('  } catch (error) {');
const finallyStart = source.lastIndexOf('  } finally {');
const catchBlock = catchStart > source.lastIndexOf('await exerciseConnectedDirtyRoot')
  ? source.slice(catchStart, finallyStart) + '  }' : '  }';
const program = `let primaryFailure; const phase = 'offline-injected'; return (async () => { try { if (bodyError) throw bodyError; ${catchBlock} finally { ${teardown} } })();`;
const run = new Function('f', 'engines', 'ownsAnchor', 'anchorPath', 'directory', 'rmSync', 'bodyError',
  new Bun.Transpiler({ loader: 'ts' }).transformSync(program));

test('connected teardown deletes durable operations before bindings and only its own source', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE sources(id text PRIMARY KEY);
      CREATE TABLE pages(id int PRIMARY KEY, source_id text REFERENCES sources(id) ON DELETE CASCADE);
      CREATE TABLE page_file_bindings(binding_id text PRIMARY KEY, source_id text REFERENCES sources(id), page_id int REFERENCES pages(id));
      CREATE TABLE page_file_operations(operation_id text PRIMARY KEY, binding_id text REFERENCES page_file_bindings(binding_id));
      CREATE TABLE page_file_write_authorizations(page_id int, operation_id text);
      INSERT INTO sources VALUES ('fixture'),('other'); INSERT INTO pages VALUES (1,'fixture'),(2,'other');
      INSERT INTO page_file_bindings VALUES ('b1','fixture',1),('b2','other',2);
      INSERT INTO page_file_operations VALUES ('op1','b1'),('op2','b2');
      INSERT INTO page_file_write_authorizations VALUES (1,'op1'),(2,'op2');`);
    const f = { source: 'fixture', admin: { executeRaw: (sql: string, args: unknown[]) => db.query(sql, args) } };
    await run(f, [], false, '', '', () => {});
    for (const table of ['sources','pages','page_file_bindings','page_file_operations','page_file_write_authorizations']) {
      expect((await db.query(`SELECT count(*)::int AS count FROM ${table}`)).rows).toEqual([{ count: 1 }]);
    }
    // Idempotent teardown must not destroy unrelated source data.
    await run(f, [], false, '', '', () => {});
  } finally { await db.close(); }
}, 20_000);

test('connected teardown retains original failure even when database cleanup fails', async () => {
  const original = new Error('original dirty-root assertion');
  const cleanup = new Error('cleanup SQL failure');
  const removed: string[] = [];
  await expect(run({ source: 'fixture', admin: { executeRaw: async () => { throw cleanup; } } }, [], true,
    'anchor', 'directory', (path: string) => removed.push(path), original)).rejects.toBe(original);
  expect(removed).toContain('directory');
});

test('connected teardown still fails when cleanup is the only failure', async () => {
  const cleanup = new Error('cleanup SQL failure');
  await expect(run({ source: 'fixture', admin: { executeRaw: async () => { throw cleanup; } } }, [], false,
    '', '', () => {})).rejects.toBe(cleanup);
});
