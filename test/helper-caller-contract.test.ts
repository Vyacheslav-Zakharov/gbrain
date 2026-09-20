import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseArgs } from './e2e/helpers/helper-v7-pull-adapter.ts';
import { parseRemoteUrl, GIT_SSRF_FLAGS } from '../src/core/git-remote.ts';
import { withEnv } from './helpers/with-env.ts';

test('frozen v7 bytes and actual CLI arguments', () => {
  const bytes = readFileSync(new URL('./e2e/helpers/helper-v7-pull-adapter.ts', import.meta.url));
  expect(createHash('sha256').update(bytes).digest('hex')).toBe('48f5d5adb636c8bade0e52d968eb0d103f9d042d0fb549d8669d4b8161b9d09e');
  for (const sourceId of ['shared', 'internal-it']) expect(parseArgs(['/runtime', sourceId, '/root'])).toEqual({ runtime: '/runtime', sourceId, approvedRoot: '/root' });
});
test('v7 static flags and parser still reject file transport', async () => {
  await withEnv({ GBRAIN_GIT_ALLOW_FILE_TRANSPORT: '1' }, () => {
    expect(() => parseRemoteUrl('file:///disposable/repository')).toThrow('https:// only');
    expect(GIT_SSRF_FLAGS).toContain('protocol.file.allow=never');
  });
});
