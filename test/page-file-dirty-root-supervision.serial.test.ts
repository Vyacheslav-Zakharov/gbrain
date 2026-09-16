import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Execute the exact supervisor with its real setsid argv and IPC options.
// Only the hosted/PG executable is substituted by an offline protocol peer.
function loadChild(script: string, capture: (proc: ReturnType<typeof Bun.spawn>) => void, observe = (_message: any) => {}) {
  const source = readFileSync(join(import.meta.dir, 'e2e/helpers/page-file-connected-dirty-root.ts'), 'utf8');
  const start = source.indexOf('async function child(');
  const end = source.indexOf('\nexport async function', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const body = source.slice(start, end).replaceAll('import.meta.dir', JSON.stringify(import.meta.dir));
  const code = new Bun.Transpiler({ loader: 'ts' }).transformSync(body);
  return new Function('Bun', 'expect', 'join', 'process', `${code}; return child;`)({
    spawn(argv: string[], options: any) {
      expect(argv[0]).toBe('setsid');
      const proc = Bun.spawn([...argv.slice(0, 2), '-e', script], {
        ...options, ipc(message: any) { observe(message); options.ipc(message); },
      });
      capture(proc);
      return proc;
    },
  }, expect, join, process) as (input: Record<string, unknown>) => Promise<any>;
}

const linuxTest = process.platform === 'linux' ? test : test.skip;
linuxTest('setsid preserves Bun IPC, PID identity and ordinary disconnect', async () => {
  let proc!: ReturnType<typeof Bun.spawn>;
  const invoke = loadChild(`process.once('message', input => {
    process.send({ result: input.value, pid: process.pid }); process.disconnect();
  });`, p => { proc = p; });
  expect(await invoke({ value: 'ok' })).toEqual({ result: 'ok', pid: proc.pid });
  expect(await proc.exited).toBe(0);
  expect(() => process.kill(proc.pid, 0)).toThrow();
});

linuxTest('parked boundary is SIGKILLed and direct child reaped', async () => {
  let proc!: ReturnType<typeof Bun.spawn>;
  const invoke = loadChild(`process.once('message', input => {
    process.on('message', () => {});
    process.send({ boundary: input.boundary, pid: process.pid });
  });`, p => { proc = p; });
  expect(await invoke({ boundary: 'dirty-root' })).toEqual({ boundary: 'dirty-root', pid: proc.pid });
  expect(proc.signalCode).toBe('SIGKILL');
  expect(await proc.exited).toBe(137);
  expect(() => process.kill(proc.pid, 0)).toThrow();
});

linuxTest('invalid boundary kills parked child; early exit is reported', async () => {
  let proc!: ReturnType<typeof Bun.spawn>;
  const invalid = loadChild(`process.once('message', () => {
    process.on('message', () => {}); process.send({ boundary: 'wrong', pid: process.pid });
  });`, p => { proc = p; });
  await expect(invalid({ boundary: 'intent' })).rejects.toThrow();
  expect(await proc.exited).toBe(137);
  expect(() => process.kill(proc.pid, 0)).toThrow();
  const early = loadChild(`process.once('message', () => process.exit(7));`, () => {});
  await expect(early({})).rejects.toThrow('exited before IPC: 7');
});

linuxTest('whole lifetime includes post-IPC hang and kills same-group descendant', async () => {
  let proc!: ReturnType<typeof Bun.spawn>;
  let descendant = 0;
  const invoke = loadChild(`process.once('message', () => {
    const descendant = Bun.spawn(['sleep', '60']);
    process.send({ result: 'sent', descendant: descendant.pid });
    setInterval(() => {}, 1000);
  });`, p => { proc = p; }, message => { descendant = message.descendant; });
  const start = performance.now();
  try {
    await expect(invoke({})).rejects.toThrow('lifetime exceeded 20s');
    expect(performance.now() - start).toBeLessThan(26_000);
    expect(descendant).toBeGreaterThan(0);
    expect(await proc.exited).toBe(137);
    expect(() => process.kill(proc.pid, 0)).toThrow();
    // A killed orphan can be a zombie until the host's PID 1 reaps it.
    // Never conflate group SIGKILL with waitpid/reaping grandchildren.
    let state = 'gone';
    for (let i = 0; i < 100; i++) {
      try { state = readFileSync(`/proc/${descendant}/stat`, 'utf8').split(') ')[1].split(' ')[0]; }
      catch { state = 'gone'; }
      if (state === 'gone' || state === 'Z') break;
      await Bun.sleep(10);
    }
    expect(['gone', 'Z']).toContain(state);
    console.log(`DIRTY_ROOT_OFFLINE: direct child reaped; descendant ${state}; no PG exercised`);
  } finally {
    try { process.kill(-proc.pid, 'SIGKILL'); } catch {}
    if (descendant) { try { process.kill(descendant, 'SIGKILL'); } catch {} }
    await proc.exited;
  }
}, 28_000);
