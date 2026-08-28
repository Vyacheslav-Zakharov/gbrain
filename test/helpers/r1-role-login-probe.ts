import postgres from 'postgres';
import { assumeProductionMigrationOwner } from '../../src/commands/r1-governed-migrate.ts';

const databaseUrl = process.env.R1_ROLE_DATABASE_URL;
const mode = process.env.R1_ROLE_PROBE_MODE;
if (!databaseUrl || (mode !== 'migrator' && mode !== 'runtime')) {
  throw new Error('R1 role probe requires database URL and migrator/runtime mode');
}

const sql = postgres(databaseUrl, { max: 1, connect_timeout: 5 });
try {
  if (mode === 'migrator') {
    await assumeProductionMigrationOwner(sql);
    const rows = await sql.unsafe("SELECT session_user,current_user,current_setting('search_path') AS search_path") as Array<{
      session_user: string; current_user: string; search_path: string;
    }>;
    process.stdout.write(`${JSON.stringify(rows[0])}\n`);
  } else {
    const rows = await sql.unsafe('SELECT session_user,current_user') as Array<{ session_user: string; current_user: string }>;
    const denied: string[] = [];
    for (const role of ['gbrain_migration_owner', 'gbrain_migrator']) {
      try {
        await sql.unsafe(`SET ROLE ${role}`);
        throw new Error(`Runtime unexpectedly assumed ${role}`);
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code !== '42501') throw error;
        denied.push(role);
      }
    }
    process.stdout.write(`${JSON.stringify({ ...rows[0], denied })}\n`);
  }
} finally {
  await sql.end({ timeout: 1 });
}
