import { expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRemoteUrl, GIT_SSRF_FLAGS } from '../src/core/git-remote.ts';
import { startHttpsGit } from './e2e/helpers/https-git.ts';
import { withEnv } from './helpers/with-env.ts';

test('real HTTPS smart Git: private admission, CA refusal, trusted ls-remote/fetch/FF, cleanup', async () => {
  const root = mkdtempSync(join(tmpdir(), 'helper-transport-'));
  const repo = join(root, 'upstream'); mkdirSync(repo);
  const env = { PATH: '/usr/bin:/bin', HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '0', GIT_TERMINAL_PROMPT: '0' };
  const git = (cwd: string, args: string[], extra = {}) => execFileSync('/usr/bin/git', ['-C', cwd, ...args], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL' }).trim();
  let server: Awaited<ReturnType<typeof startHttpsGit>> | undefined;
  try {
    git(repo, ['init', '-b', 'master']);
    git(repo, ['config', 'user.name', 'Fixture']); git(repo, ['config', 'user.email', 'fixture@example.invalid']);
    git(repo, ['config', 'commit.gpgSign', 'false']);
    writeFileSync(join(repo, 'data.txt'), 'baseline\n'); git(repo, ['add', '.']); git(repo, ['commit', '-m', 'baseline']);
    const baseline = git(repo, ['rev-parse', 'HEAD']);
    server = await startHttpsGit(repo);
    const endpoint = server.url;
    await withEnv({ GBRAIN_ALLOW_PRIVATE_REMOTES: undefined }, () => expect(() => parseRemoteUrl(endpoint)).toThrow('internal/private'));
    await withEnv({ GBRAIN_ALLOW_PRIVATE_REMOTES: '1' }, () => expect(parseRemoteUrl(endpoint).url).toBe(endpoint));
    const untrusted = spawnSync('/usr/bin/git', [...GIT_SSRF_FLAGS, 'ls-remote', endpoint], { env, encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL' });
    expect(untrusted.status).not.toBe(0); expect(untrusted.stderr).toMatch(/certificate|SSL/i);
    console.log('RED control: untrusted fixture CA rejected with TLS verification enabled');
    const trust = { GIT_SSL_CAINFO: server.ca, GIT_SSL_VERIFY: 'true' };
    expect(git(root, [...GIT_SSRF_FLAGS, 'ls-remote', endpoint], trust)).toContain(baseline);
    const client = join(root, 'client'); mkdirSync(client); git(client, ['init', '-b', 'master']);
    git(client, ['remote', 'add', 'origin', endpoint]);
    git(client, [...GIT_SSRF_FLAGS, 'fetch', '--no-recurse-submodules', 'origin', 'master'], trust);
    git(client, ['checkout', '-B', 'master', 'FETCH_HEAD']);
    writeFileSync(join(repo, 'data.txt'), 'incoming\n'); git(repo, ['commit', '-am', 'incoming']);
    const incoming = git(repo, ['rev-parse', 'HEAD']);
    git(client, [...GIT_SSRF_FLAGS, 'pull', '--ff-only', '--no-recurse-submodules', 'origin', 'master'], trust);
    expect(git(client, ['rev-parse', 'HEAD'])).toBe(incoming);
    expect(incoming).not.toBe(baseline);
    console.log('GREEN: accepted static flags; trusted ls-remote, fetch, and FF pull');
  } finally {
    if (server) {
      await server.stop();
      expect(existsSync(server.directory)).toBe(false);
      const stoppedPid = server.pid;
      expect(() => process.kill(stoppedPid, 0)).toThrow();
    }
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
