import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { buildZeroRowInsert, stripNoexecGuard, verifyControlManifest } from '../scripts/g5-acl-hosted-lib.ts';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');

describe('G5 ACL hosted control binding', () => {
  test('accepts exact manifest bytes and exact entry bytes', () => {
    const root = mkdtempSync(join(tmpdir(), 'g5-acl-manifest-'));
    writeFileSync(join(root, 'a.txt'), 'alpha\n');
    const manifest = `${sha('alpha\n')}  a.txt\n`;
    writeFileSync(join(root, 'G5-ACL-DRAFT-SHA256SUMS'), manifest);
    expect(verifyControlManifest(root, sha(manifest))).toEqual({ entries: 1, bindingSha256: sha(manifest) });
  });

  test('rejects stale entry bytes and wrong external binding', () => {
    const root = mkdtempSync(join(tmpdir(), 'g5-acl-manifest-'));
    writeFileSync(join(root, 'a.txt'), 'alpha\n');
    const manifest = `${sha('alpha\n')}  a.txt\n`;
    writeFileSync(join(root, 'G5-ACL-DRAFT-SHA256SUMS'), manifest);
    writeFileSync(join(root, 'a.txt'), 'changed\n');
    expect(() => verifyControlManifest(root, sha(manifest))).toThrow('entry hash mismatch');
    writeFileSync(join(root, 'a.txt'), 'alpha\n');
    expect(() => verifyControlManifest(root, '0'.repeat(64))).toThrow('binding mismatch');
  });

  test('strips only the exact deliberate three-line NOEXEC guard', () => {
    const sql = "\\set ON_ERROR_STOP on\n\\echo 'NOEXEC sample'\nDO $g5_noexec$ BEGIN RAISE EXCEPTION 'NOEXEC sample'; END $g5_noexec$;\n\nBEGIN;\nSELECT 1;\nCOMMIT;\n";
    expect(stripNoexecGuard(sql)).toBe('BEGIN;\nSELECT 1;\nCOMMIT;\n');
    expect(stripNoexecGuard(sql.replace("$g5_noexec$;\n\nBEGIN", "$g5_noexec$;\nBEGIN"))).toBe('BEGIN;\nSELECT 1;\nCOMMIT;\n');
    expect(() => stripNoexecGuard(sql.replace('RAISE EXCEPTION', 'RAISE NOTICE'))).toThrow('guard');
    expect(() => stripNoexecGuard(sql.replace('\\set ON_ERROR_STOP on', '\\set ON_ERROR_STOP off'))).toThrow('guard');
    expect(() => stripNoexecGuard(sql.replace("; END $g5_noexec$;", "; EXCEPTION WHEN OTHERS THEN NULL; END $g5_noexec$;"))).toThrow('guard');
  });

  test('builds INSERT-only zero-row probes without selecting the target table', () => {
    const sql = buildZeroRowInsert('synthesis_evidence', [
      { column_name: 'page_id', type_sql: 'bigint' },
      { column_name: 'evidence', type_sql: 'jsonb' },
    ]);
    expect(sql).toBe('INSERT INTO public."synthesis_evidence" ("page_id","evidence") SELECT NULL::bigint,NULL::jsonb WHERE false');
    expect(sql).not.toContain('FROM public.');
  });
});
