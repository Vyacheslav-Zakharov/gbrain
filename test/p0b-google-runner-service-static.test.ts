import { describe, expect, test } from 'bun:test';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  P0B_GOOGLE_RUNTIME_EXECUTION_STATE,
  withP0BGoogleCredential,
} from '../src/core/p0b-google-credential.ts';
import { createP0BGoogleProviderProcess } from '../src/core/p0b-google-provider-process.ts';
import { runP0BGoogleOfflineRunner } from '../src/core/p0b-google-offline-runner.ts';

const root = join(import.meta.dir, '..');
const blocked = 'P0B_GOOGLE_RUNTIME_UNFINALIZED_NOEXEC';

function hostile(label: string): any {
  return new Proxy({}, { get() { throw new Error(`${label}_MUST_NOT_BE_READ`); } });
}

describe('P0-B runtime is an honest UNFINALIZED NOEXEC artifact', () => {
  test('credential boundary throws before reading store, callback, path, or metadata', async () => {
    expect(P0B_GOOGLE_RUNTIME_EXECUTION_STATE).toBe('UNFINALIZED_NOEXEC');
    let opened = 0;
    let used = 0;
    await expect(withP0BGoogleCredential({
      async open() { opened += 1; throw new Error('STORE_MUST_NOT_BE_CALLED'); },
    }, async () => { used += 1; return 'bad'; })).rejects.toThrow(blocked);
    await expect(withP0BGoogleCredential(hostile('STORE'), hostile('CALLBACK'))).rejects.toThrow(blocked);
    expect(opened).toBe(0);
    expect(used).toBe(0);
  });

  test('provider throws before reading credential, request, or launcher', async () => {
    let launched = 0;
    const provider = createP0BGoogleProviderProcess({
      async launch() { launched += 1; throw new Error('LAUNCHER_MUST_NOT_BE_CALLED'); },
    });
    await expect(provider.embedWithCredential(hostile('CREDENTIAL'), hostile('REQUEST'))).rejects.toThrow(blocked);
    expect(launched).toBe(0);
  });

  test('runner throws before reading request or any dependency', async () => {
    await expect(runP0BGoogleOfflineRunner(hostile('REQUEST'), hostile('DEPENDENCIES'))).rejects.toThrow(blocked);
  });

  test('runtime files are not exported or wired into production entrypoints', async () => {
    for (const relative of ['src/core/index.ts', 'src/cli.ts', 'src/mcp/server.ts']) {
      const source = await readFile(join(root, relative), 'utf8');
      expect(source).not.toContain('p0b-google-offline-runner');
      expect(source).not.toContain('p0b-google-provider-process');
      expect(source).not.toContain('p0b-google-credential');
    }
  });

  test('service/timer/SQL are regular NOEXEC files with independent hard fences', async () => {
    const paths = [
      'ops/p0b-google-runner/gbrain-p0b-google-bridge.service.NOEXEC',
      'ops/p0b-google-runner/gbrain-p0b-google-bridge.timer.NOEXEC',
      'ops/p0b-google-runner/legacy-embed-fence.sql.NOEXEC',
      'ops/p0b-google-runner/ACTIVATION-ROLLBACK-BLOCKED.md',
      'ops/p0b-google-runner/manifest.template.json',
    ];
    for (const relative of paths) {
      const stat = await lstat(join(root, relative));
      expect(stat.isFile()).toBe(true);
      expect(stat.isSymbolicLink()).toBe(false);
      expect(stat.mode & 0o111).toBe(0);
    }
    const service = await readFile(join(root, paths[0]), 'utf8');
    expect(service).toContain('ExecCondition=/usr/bin/false');
    expect(service).toContain('RestrictAddressFamilies=AF_UNIX');
    expect(service).not.toContain('AF_INET');
    expect(service).not.toContain('AF_INET6');
    expect(service).not.toContain('[Install]');
    const sql = await readFile(join(root, paths[2]), 'utf8');
    expect(sql).toContain('P0B_LEGACY_FENCE_UNFINALIZED_NOEXEC');
    expect(sql).not.toContain('CREATE TRIGGER');
    expect(sql).not.toContain('CREATE OR REPLACE FUNCTION');
    expect(sql).not.toContain("current_setting('gbrain.embedding_writer'");
  });

  test('manifest and blocker disclose all unresolved execution gates', async () => {
    const manifest = JSON.parse(await readFile(join(root, 'ops/p0b-google-runner/manifest.template.json'), 'utf8'));
    expect(manifest.execution_state).toBe('UNFINALIZED_NOEXEC');
    expect(manifest.candidate_commit_sha).toContain('REPLACE_WITH_');
    expect(manifest.package_root_sha256).toContain('REPLACE_WITH_');
    for (const file of Object.values(manifest.files) as any[]) {
      expect(file.sha256).toContain('REPLACE_WITH_');
    }
    const blocker = await readFile(join(root, 'ops/p0b-google-runner/ACTIVATION-ROLLBACK-BLOCKED.md'), 'utf8');
    for (const marker of ['UNFINALIZED_NOEXEC', 'schema', 'ACL', 'provider', 'legacy']) {
      expect(blocker.toLowerCase()).toContain(marker.toLowerCase());
    }
  });

  test('sources contain no environment credential fallback or shared gateway wiring', async () => {
    for (const relative of [
      'src/core/p0b-google-credential.ts',
      'src/core/p0b-google-provider-process.ts',
      'src/core/p0b-google-offline-runner.ts',
    ]) {
      const source = await readFile(join(root, relative), 'utf8');
      expect(source).not.toContain('process.env');
      expect(source).not.toContain('process.argv');
      expect(source).not.toContain("./ai/gateway");
    }
  });
});
