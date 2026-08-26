import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configPath, loadConfigFileSnapshotStrict } from '../src/core/config.ts';

let root = '';
let priorHome: string | undefined;

beforeEach(() => {
  priorHome = process.env.GBRAIN_HOME;
  root = mkdtempSync(join(tmpdir(), 'r1-config-snapshot-'));
  process.env.GBRAIN_HOME = root;
});

afterEach(() => {
  if (priorHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = priorHome;
  rmSync(root, { recursive: true, force: true });
});

describe('R1 strict config file snapshot', () => {
  test('allows only an absent file or a valid object with a stable full fingerprint', () => {
    expect(loadConfigFileSnapshotStrict()).toEqual({ config: null, sha256: 'absent' });
    mkdirSync(join(root, '.gbrain'), { recursive: true });
    writeFileSync(configPath(), '{"engine":"postgres","embedding_model":"google:gemini-embedding-001"}');
    const first = loadConfigFileSnapshotStrict();
    const second = loadConfigFileSnapshotStrict();
    expect(first.config?.embedding_model).toBe('google:gemini-embedding-001');
    expect(first.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(second.sha256).toBe(first.sha256);
  });

  test('fails closed on malformed JSON and non-object JSON', () => {
    mkdirSync(join(root, '.gbrain'), { recursive: true });
    writeFileSync(configPath(), '{broken');
    expect(() => loadConfigFileSnapshotStrict()).toThrow('Invalid config.json');
    writeFileSync(configPath(), 'null');
    expect(() => loadConfigFileSnapshotStrict()).toThrow('must contain a JSON object');
    writeFileSync(configPath(), '[]');
    expect(() => loadConfigFileSnapshotStrict()).toThrow('must contain a JSON object');
  });
});
