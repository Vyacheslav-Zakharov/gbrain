import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { runPull } from '../src/commands/sources-harden.ts';

// Exercise the real command boundary, stopping at its first database read.
// No copied/extracted parser and no module mocks: capture the exact source bind.
const reachedSourceLookup = new Error('reached source lookup');
const lookups: unknown[][] = [];
const engine = {
  executeRaw: async (_sql: string, params: unknown[]) => {
    lookups.push(params);
    throw reachedSourceLookup;
  },
} as unknown as BrainEngine;
const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  lookups.length = 0;
});

function trapExit() {
  spies.push(spyOn(console, 'error').mockImplementation(() => {}));
  spies.push(spyOn(process, 'exit').mockImplementation((code) => {
    throw new Error(`exit:${code}`);
  }));
}

test('sources pull main --branch main preserves positional source main', async () => {
  trapExit();
  await expect(runPull(engine, ['main', '--branch', 'main'])).rejects.toBe(reachedSourceLookup);
  expect(lookups).toEqual([['main']]);
});

for (const args of [
  ['example', '--branch', 'main'],
  ['--branch', 'main', 'example'],
  ['--branch', 'main', 'main'],
  ['main', '--branch=main'],
  ['--branch=main', 'main'],
  ['main'],
  ['--recover-root', '--yes', 'main', '--branch', 'main'],
  ['--branch', 'main', '--yes', 'main', '--recover-root'],
  ['Main.Mixed_ID', '--branch', 'Main.Mixed_ID'],
]) {
  test(`source binding is verbatim: ${args.join(' ')}`, async () => {
    trapExit();
    const expected = args.includes('example') ? 'example' : args.includes('Main.Mixed_ID') ? 'Main.Mixed_ID' : 'main';
    await expect(runPull(engine, args)).rejects.toBe(reachedSourceLookup);
    expect(lookups).toEqual([[expected]]);
  });
}

for (const args of [[], ['--branch', 'main'], ['--branch=main'], ['--recover-root', '--yes', '--branch', 'main']]) {
  test(`absent source retains usage exit 2: ${args.join(' ')}`, async () => {
    trapExit();
    await expect(runPull(engine, args)).rejects.toThrow('exit:2');
    expect(lookups).toEqual([]);
    expect(console.error).toHaveBeenCalledWith('Usage: gbrain sources pull <id> | --path <dir> [--branch <b>]');
  });
}

for (const inline of [false, true]) {
  test(`--path ${inline ? 'inline' : 'separate'} retains precedence and DB-free gate`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-pull-args-'));
    // Only the existing .git existence check is reached before the DB-free gate.
    mkdirSync(join(root, '.git'));
    try {
      const pathArgs = inline ? [`--path=${root}`] : ['--path', root];
      await expect(runPull(null, ['main', ...pathArgs, '--branch', 'main', '--recover-root', '--yes']))
        .rejects.toThrow('page_file_root_gate_unavailable');
      expect(lookups).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('missing engine retains usage exit 2 for a positional source', async () => {
  trapExit();
  await expect(runPull(null, ['main', '--branch', 'main'])).rejects.toThrow('exit:2');
});

test('unknown source retains exit 1', async () => {
  trapExit();
  const absentEngine = { executeRaw: async () => [] } as unknown as BrainEngine;
  await expect(runPull(absentEngine, ['main', '--branch', 'main'])).rejects.toThrow('exit:1');
  expect(console.error).toHaveBeenCalledWith('Source "main" not found or has no local_path.');
});

test('non-git --path retains exit 1 without a source lookup', async () => {
  trapExit();
  const root = mkdtempSync(join(tmpdir(), 'gbrain-pull-args-'));
  try {
    await expect(runPull(engine, ['--path', root, '--branch=main'])).rejects.toThrow('exit:1');
    expect(lookups).toEqual([]);
    expect(console.error).toHaveBeenCalledWith(`[gbrain] not a git repo: ${root}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
