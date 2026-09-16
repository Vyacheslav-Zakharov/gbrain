import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snapshotCrashJournal } from './e2e/helpers/page-file-connected-crash.ts';

// Execute the helper's exact function, not a model of its control flow. Only
// spawn argv is replaced: a real offline OS child sends IPC and stays alive.
function loadChild(script: string, capture: (proc: ReturnType<typeof Bun.spawn>) => void, onMessage = (_message: any) => {}) {
  const path = join(import.meta.dir, 'e2e/helpers/page-file-connected-crash.ts');
  const source = readFileSync(path, 'utf8');
  const start = source.indexOf('async function child(');
  const end = source.indexOf('\n/** Reuses', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const body = source.slice(start, end).replaceAll('import.meta.dir', JSON.stringify(join(import.meta.dir, 'e2e/helpers')));
  const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(body);
  return new Function('Bun', 'expect', 'join', 'process', `${js}; return child;`)({
    spawn(_argv: string[], options: any) {
      const proc = Bun.spawn([process.execPath, '-e', script], {
        ...options, ipc(message: any) { onMessage(message); options.ipc(message); },
      });
      capture(proc);
      return proc;
    },
  }, expect, join, process) as (input: Record<string, unknown>) => Promise<any>;
}

test('15s lifetime deadline kills and reaps a real child hung AFTER successful IPC', async () => {
  let proc!: ReturnType<typeof Bun.spawn>;
  let received = false;
  const invoke = loadChild(`process.once('message', () => {
    process.send({ result: 'sent-before-hang' });
    setInterval(() => {}, 1000);
  });`, p => { proc = p; }, message => { received = message.result === 'sent-before-hang'; });
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const started = performance.now();
  try {
    const pending = invoke({});
    // Observe the actual IPC without changing the supervisor's receive path.
    // The child's active handle and receipt are independently confirmed below.
    const outcome = await Promise.race([
      pending.then(() => ({ kind: 'resolved', error: '' }), error => ({ kind: 'rejected', error: String(error) })),
      new Promise<{ kind: string; error: string }>(resolve => {
        watchdog = setTimeout(() => resolve({ kind: 'watchdog', error: 'supervisor still pending after its 15s deadline' }), 17_000);
      }),
    ]);
    expect(received).toBe(true);
    expect(outcome.kind).toBe('rejected');
    expect(outcome.error).toContain('deadline');
    expect(performance.now() - started).toBeLessThan(17_000);
    expect(proc.signalCode).toBe('SIGKILL');
    expect(await proc.exited).toBe(137); // Bun keeps exitCode null for signal exits.
    expect(() => process.kill(proc.pid, 0)).toThrow();
  } finally {
    clearTimeout(watchdog);
    if (proc?.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
    if (proc) await proc.exited;
  }
}, 20_000);

test('invalid boundary IPC is rejected and the parked child is killed/reaped', async () => {
  let proc!: ReturnType<typeof Bun.spawn>;
  const invoke = loadChild(`process.once('message', () => {
    process.send({ boundary: 'wrong', pid: process.pid });
    setInterval(() => {}, 1000);
  });`, p => { proc = p; });
  try {
    await expect(invoke({ boundary: 'prepared' })).rejects.toThrow();
    expect(proc.signalCode).toBe('SIGKILL');
    expect(await proc.exited).toBe(137);
    expect(() => process.kill(proc.pid, 0)).toThrow();
  } finally {
    if (proc?.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
    if (proc) await proc.exited;
  }
});

test('valid boundary IPC requires actual SIGKILL and reap', async () => {
  let proc!: ReturnType<typeof Bun.spawn>;
  const invoke = loadChild(`process.once('message', input => {
    process.send({ boundary: input.boundary, pid: process.pid });
    setInterval(() => {}, 1000);
  });`, p => { proc = p; });
  expect(await invoke({ boundary: 'prepared' })).toEqual({ boundary: 'prepared', pid: proc.pid });
  expect(proc.signalCode).toBe('SIGKILL');
  expect(await proc.exited).toBe(137);
});

test('exit before IPC fails promptly and ordinary result exits cleanly', async () => {
  const early = loadChild(`process.once('message', () => process.exit(7));`, () => {});
  await expect(early({})).rejects.toThrow('exited before IPC: 7');
  const clean = loadChild(`process.once('message', () => {
    process.send({ result: 'ok' }); process.disconnect();
  });`, () => {});
  expect(await clean({})).toEqual({ result: 'ok' });
});

test('journal snapshots preserve binary bytes, record bytes, tree and withheld evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'crash-evidence-'));
  const operation = join(root, 'operation'), withheld = operation + '.withheld';
  try {
    mkdirSync(operation);
    writeFileSync(join(operation, 'before'), Buffer.from([0xff]));
    writeFileSync(join(operation, 'after'), Buffer.from([0x00, 0xfe]));
    writeFileSync(join(operation, 'record.json'), '{"a":1}');
    const original = snapshotCrashJournal(root);
    writeFileSync(join(operation, 'before'), Buffer.from([0xfe]));
    expect(snapshotCrashJournal(root)).not.toEqual(original); // same UTF-8 replacement char
    writeFileSync(join(operation, 'before'), Buffer.from([0xff]));
    writeFileSync(join(operation, 'record.json'), '{ "a": 1 }');
    expect(snapshotCrashJournal(root)).not.toEqual(original); // same parsed JSON
    writeFileSync(join(operation, 'record.json'), '{"a":1}');
    expect(snapshotCrashJournal(root)).toEqual(original);
    const evidence = snapshotCrashJournal(operation);
    renameSync(operation, withheld);
    expect(snapshotCrashJournal(operation)).toEqual({ absent: true });
    expect(snapshotCrashJournal(withheld)).toEqual(evidence);
    expect(snapshotCrashJournal(root)).not.toEqual(original);
    renameSync(withheld, operation);
    expect(snapshotCrashJournal(root)).toEqual(original);
    mkdirSync(join(root, 'extra-empty-entry'));
    expect(snapshotCrashJournal(root)).not.toEqual(original);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
