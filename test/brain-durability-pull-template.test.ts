import { describe, expect, test } from 'bun:test';
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Extract the generated template without importing engine/config modules or
// installing hooks/crons. Execute only the finite brain_push function.
const source = readFileSync(new URL('../src/core/brain-repo-durability.ts', import.meta.url), 'utf8');
function pushTemplate(): string {
  const raw = source.match(/const PUSH_RETRY = `([\s\S]*?)`;/)![1];
  return raw.replace(/\\\$/g, '$');
}

describe('generated durability pull boundary', () => {
  test('both pull sites use the coordinated source route, never raw rebase/abort', () => {
    const templates = source.slice(source.indexOf('const PUSH_RETRY'), source.indexOf('// ── Managed AGENTS'));
    expect(templates).not.toContain('git pull --rebase');
    expect(templates).not.toContain('git rebase --abort');
    expect(templates).toContain('sources pull');
    expect(templates).not.toContain('sources pull --path');
  });

  test('lock contention and no-change helper cannot falsely guarantee a push', () => {
    expect(pushTemplate()).not.toMatch(/lock-timeout[^\n]*return 0/);
    expect(source).not.toContain('echo "nothing to commit"; exit 0');
    expect(pushTemplate()).not.toContain('ok-after-rebase');
  });

  test('unenrolled push-only still reaches a real local bare origin without a CLI', () => {
    const root = mkdtempSync(join(tmpdir(), 'durability-legacy-'));
    try {
      const env = { PATH: '/usr/bin:/bin', HOME: root, GBRAIN_HOME: root,
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
      const git = (...args: string[]) => {
        const result = spawnSync('git', args, { cwd: root, env, encoding: 'utf8', timeout: 3000 });
        expect(result.status).toBe(0); return result.stdout.trim();
      };
      git('init', '--bare', '--initial-branch=main', 'origin.git');
      git('init', '--initial-branch=main', 'work');
      git('-C', 'work', 'config', 'user.name', 'Fixture');
      git('-C', 'work', 'config', 'user.email', 'fixture@example.invalid');
      git('-C', 'work', 'commit', '--allow-empty', '-m', 'fixture');
      git('-C', 'work', 'remote', 'add', 'origin', join(root, 'origin.git'));
      const result = spawnSync('bash', ['-c', pushTemplate() + '\nbrain_push main'], {
        cwd: join(root, 'work'), env, encoding: 'utf8', timeout: 3000,
      });
      expect(result.status).toBe(0);
      expect(git('--git-dir=origin.git', 'rev-parse', 'main')).toBe(git('-C', 'work', 'rev-parse', 'HEAD'));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('push rejection cannot report success when coordinated pull refuses', () => {
    const root = mkdtempSync(join(tmpdir(), 'durability-template-'));
    try {
      const bin = join(root, 'bin'); mkdirSync(bin);
      const calls = join(root, 'calls');
      writeFileSync(join(bin, 'git'), '#!/bin/bash\nprintf "%s\\n" "$*" >> "$CALLS"\ncase "$1" in\n rev-parse) echo .git;;\n push) exit 1;;\n *) exit 0;;\nesac\n', { mode: 0o755 });
      writeFileSync(join(bin, 'gbrain'), '#!/bin/bash\nprintf "%s\\n" "$*" >> "$CALLS"\necho page_file_root_gate_unavailable >&2\nexit 7\n', { mode: 0o755 });
      mkdirSync(join(root, '.git'));
      const result = spawnSync('bash', ['-c', pushTemplate() + '\nbrain_push main'], {
        cwd: root, timeout: 3000, encoding: 'utf8',
        env: { PATH: bin + ':/usr/bin:/bin', HOME: root, GBRAIN_HOME: root, CALLS: calls, _gbrain_source: 'wiki' },
      });
      expect(result.status).toBe(1);
      const log = readFileSync(join(root, 'brain-push.log'), 'utf8');
      expect(log).toContain('NEEDS ATTENTION');
      expect(log).not.toContain('ok-after-rebase');
      const invoked = readFileSync(calls, 'utf8');
      expect(invoked).toContain('sources pull wiki --branch main');
      expect(invoked.split('push origin').length - 1).toBe(1);
      expect(invoked).not.toContain('pull --rebase');
      expect(invoked).not.toContain('rebase --abort');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
