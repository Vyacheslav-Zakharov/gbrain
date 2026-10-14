import { test, expect } from 'bun:test';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { withExclusiveSourceWrites } from '../src/core/write-admission.ts';
import { installHttpWriteAdmission, withWorkerWriteAdmission, withCliWriteAdmission } from '../src/core/write-admission-boundaries.ts';

test('HTTP final handler, worker and CLI refuse before effects while GET remains available', async () => {
  const path = mkdtempSync(join(tmpdir(), 'gbrain-admission-boundaries-'));
  const engine = { executeRaw: async () => [{ id: 'shared', local_path: path }] } as unknown as BrainEngine;
  const app = express();
  installHttpWriteAdmission(app, engine);
  let effects = 0;
  app.post('/admin/api/ai-review/proposals/:id/accept', async (_req, res) => { effects++; res.json({ ok: true }); });
  app.post('/portal/api/review/items/:assignmentId/vote', async (_req, res) => { effects++; res.json({ ok: true }); });
  app.get('/portal/api/page', (_req, res) => res.json({ text: 'readable' }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(r => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    await withExclusiveSourceWrites(engine, ['shared'], async () => {
      for (const route of ['/admin/api/ai-review/proposals/1/accept', '/portal/api/review/items/1/vote']) {
        const response = await fetch(base + route, { method: 'POST' });
        expect(response.status).toBe(503);
        expect((await response.json() as any).error).toBe('source_write_busy');
      }
      expect((await fetch(base + '/portal/api/page')).status).toBe(200);
      // These independent callbacks must not inherit this test's exclusive grant.
      // HTTP has its own async request context; test worker/CLI outside below.
      expect(effects).toBe(0);
    });
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>(r => entered = r), stop = new Promise<void>(r => release = r);
    const holder = withExclusiveSourceWrites(engine, ['shared'], async () => { entered(); await stop; });
    try {
      await ready;
      await expect(withWorkerWriteAdmission(engine, 'cycle', {}, async () => { effects++; })).rejects.toMatchObject({ code: 'SOURCE_WRITE_BUSY' });
      await expect(withCliWriteAdmission(engine, 'reindex', [], async () => { effects++; })).rejects.toMatchObject({ code: 'SOURCE_WRITE_BUSY' });
      await withCliWriteAdmission(engine, 'status', [], async () => 'readable');
      expect(effects).toBe(0);
    } finally { release(); await holder; }
  } finally {
    server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));
    rmSync(path, { recursive: true, force: true });
  }
});
