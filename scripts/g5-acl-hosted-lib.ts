import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const HEX64 = /^[0-9a-f]{64}$/;
const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

export function verifyControlManifest(root: string, expectedBindingSha256: string): { entries: number; bindingSha256: string } {
  if (!HEX64.test(expectedBindingSha256)) throw new Error('invalid expected binding');
  const manifestPath = join(root, 'G5-ACL-DRAFT-SHA256SUMS');
  const manifestBytes = readFileSync(manifestPath);
  const bindingSha256 = sha256(manifestBytes);
  if (bindingSha256 !== expectedBindingSha256) {
    throw new Error(`binding mismatch: expected ${expectedBindingSha256}, got ${bindingSha256}`);
  }

  const seen = new Set<string>();
  const lines = manifestBytes.toString('utf8').split('\n').filter(Boolean);
  if (lines.length === 0) throw new Error('empty control manifest');
  for (const line of lines) {
    const match = /^([0-9a-f]{64})  ([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(line);
    if (!match) throw new Error(`malformed manifest line: ${line}`);
    const [, expected, name] = match;
    if (basename(name) !== name || seen.has(name)) throw new Error(`unsafe or duplicate manifest entry: ${name}`);
    seen.add(name);
    const actual = sha256(readFileSync(join(root, name)));
    if (actual !== expected) throw new Error(`entry hash mismatch: ${name}`);
  }
  return { entries: lines.length, bindingSha256 };
}

export function stripNoexecGuard(sql: string): string {
  const lines = sql.replaceAll('\r\n', '\n').split('\n');
  const exactException = /^DO \$g5_noexec\$ BEGIN RAISE EXCEPTION '(?:[^']|'')*'; END \$g5_noexec\$;$/;
  if (
    lines[0] !== '\\set ON_ERROR_STOP on' ||
    !/^\\echo 'NOEXEC [^']*'$/.test(lines[1] ?? '') ||
    !exactException.test(lines[2] ?? '')
  ) {
    throw new Error('invalid or missing NOEXEC guard');
  }
  return lines.slice(lines[3] === '' ? 4 : 3).join('\n');
}

export function buildZeroRowInsert(table: string, columns: Array<{ column_name: string; type_sql: string }>): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(table) || columns.length === 0) throw new Error('invalid zero-row INSERT metadata');
  const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
  const names = columns.map((column) => quote(column.column_name)).join(',');
  const values = columns.map((column) => `NULL::${column.type_sql}`).join(',');
  return `INSERT INTO public.${quote(table)} (${names}) SELECT ${values} WHERE false`;
}
