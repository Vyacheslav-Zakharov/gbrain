import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { OperationError, operationsByName, type OperationContext } from '../src/core/operations.ts';

let engine: PGLiteEngine;
let sourceDir: string;
const tempDirs: string[] = [];
const sourceId = 'attachment-test';

function makeContext(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine,
    config: {} as OperationContext['config'],
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    } as unknown as OperationContext['logger'],
    dryRun: false,
    remote: true,
    sourceId,
    auth: {
      token: 'attachment-test-token',
      clientId: 'attachment-test-client',
      scopes: ['read', 'write'],
      sourceId,
      allowedSources: [sourceId],
      writeSources: [sourceId],
    },
    ...overrides,
  };
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 30_000);

afterAll(async () => {
  await engine.disconnect();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  sourceDir = mkdtempSync(join(tmpdir(), 'gbrain-attachment-test-'));
  tempDirs.push(sourceDir);
  await engine.executeRaw('DELETE FROM files WHERE source_id = $1', [sourceId]);
  await engine.executeRaw('DELETE FROM pages WHERE source_id = $1', [sourceId]);
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, archived)
     VALUES ($1, $2, $3, false)
     ON CONFLICT (id) DO UPDATE SET local_path = EXCLUDED.local_path, archived = false`,
    [sourceId, 'Attachment Test Source', sourceDir],
  );
});

describe('source-scoped attachment operations', () => {
  test('registers the production MCP contract with explicit scopes', () => {
    const upload = operationsByName.attachment_upload;
    const list = operationsByName.attachment_list;
    const get = operationsByName.attachment_get;
    expect(upload).toBeDefined();
    expect(list).toBeDefined();
    expect(get).toBeDefined();
    expect(upload.scope).toBe('write');
    expect(upload.mutating).toBe(true);
    expect(upload.params.source_id).toMatchObject({ type: 'string', required: false });
    expect(upload.params.auto_extract).toMatchObject({ type: 'boolean', required: false });
    expect(list.scope).toBe('read');
    expect(get.scope).toBe('read');
  });

  test('rejects an ungranted remote source before filesystem or database access', async () => {
    const upload = operationsByName.attachment_upload;
    await expect(upload.handler(makeContext(), {
      source_id: 'restricted-source',
      filename: 'secret.txt',
      content_base64: Buffer.from('secret').toString('base64'),
    })).rejects.toMatchObject({ code: 'permission_denied' });
  });

  test('uploads, lists, and reads a binary-safe attachment with integrity checks', async () => {
    const payload = Buffer.from([0, 1, 2, 3, 254, 255]);
    const uploaded = await operationsByName.attachment_upload.handler(makeContext(), {
      source_id: sourceId,
      filename: '../quarterly report.bin',
      content_base64: payload.toString('base64'),
      auto_extract: false,
    }) as Record<string, unknown>;

    expect(uploaded.status).toBe('uploaded');
    expect(uploaded.filename).toBe('quarterly-report.bin');
    expect(uploaded.source_id).toBe(sourceId);
    expect(readFileSync(join(sourceDir, uploaded.repo_relative_path as string))).toEqual(payload);

    const listed = await operationsByName.attachment_list.handler(makeContext(), {
      source_id: sourceId,
      limit: 10,
    }) as Array<Record<string, unknown>>;
    expect(listed).toHaveLength(1);
    expect(listed[0].storage_path).toBe(uploaded.storage_path);

    const fetched = await operationsByName.attachment_get.handler(makeContext(), {
      storage_path: uploaded.storage_path,
    }) as Record<string, unknown>;
    expect(Buffer.from(fetched.content_base64 as string, 'base64')).toEqual(payload);
    expect(fetched.sha256).toBe(uploaded.sha256);
  });

  test('creates a typed searchable index from caller-supplied extracted text', async () => {
    const uploaded = await operationsByName.attachment_upload.handler(makeContext(), {
      source_id: sourceId,
      filename: 'scanned-policy.pdf',
      content_base64: Buffer.from('%PDF-1.4\nplaceholder').toString('base64'),
      extracted_text: 'Approved maintenance interval is exactly forty-two days.',
    }) as {
      indexed_page: { slug: string; status: string; chunks: number };
      extraction: { method: string; chars: number };
    };

    expect(uploaded.extraction.method).toBe('caller_supplied_extracted_text');
    expect(uploaded.indexed_page.status).toBe('imported');
    expect(uploaded.indexed_page.chunks).toBeGreaterThan(0);
    const page = await engine.getPage(uploaded.indexed_page.slug, { sourceId });
    expect(page?.compiled_truth).toContain('forty-two days');
    expect(readFileSync(join(sourceDir, `${uploaded.indexed_page.slug}.md`), 'utf8'))
      .toContain('caller_supplied_extracted_text');
  });

  test('rejects malformed base64, executable extensions, and traversal storage paths', async () => {
    const upload = operationsByName.attachment_upload;
    await expect(upload.handler(makeContext(), {
      filename: 'payload.txt',
      content_base64: 'not-base64',
    })).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(upload.handler(makeContext(), {
      filename: 'payload.sh',
      content_base64: Buffer.from('echo unsafe').toString('base64'),
    })).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(operationsByName.attachment_get.handler(makeContext(), {
      storage_path: `${sourceId}/../outside.txt`,
    })).rejects.toBeInstanceOf(OperationError);
  });

  test('fails closed when a stored file is modified after upload', async () => {
    const uploaded = await operationsByName.attachment_upload.handler(makeContext(), {
      filename: 'integrity.txt',
      content_base64: Buffer.from('original').toString('base64'),
      auto_extract: false,
    }) as Record<string, unknown>;
    writeFileSync(join(sourceDir, uploaded.repo_relative_path as string), 'tampered');

    await expect(operationsByName.attachment_get.handler(makeContext(), {
      storage_path: uploaded.storage_path,
    })).rejects.toMatchObject({ code: 'storage_error' });
  });

  test('never follows attachment symlinks on upload or get', async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), 'gbrain-attachment-outside-'));
    tempDirs.push(outsideDir);
    const outsideFile = join(outsideDir, 'sentinel.txt');
    writeFileSync(outsideFile, 'outside-secret');

    const payload = Buffer.from('safe-payload');
    const hash = createHash('sha256').update(payload).digest('hex');
    const attachmentsDir = join(sourceDir, '_attachments');
    mkdirSync(attachmentsDir, { recursive: true });
    const linkedPath = join(attachmentsDir, `${hash.slice(0, 12)}-linked.txt`);
    symlinkSync(outsideFile, linkedPath);

    await expect(operationsByName.attachment_upload.handler(makeContext(), {
      filename: 'linked.txt',
      content_base64: payload.toString('base64'),
      auto_extract: false,
    })).rejects.toMatchObject({ code: 'storage_error' });
    expect(readFileSync(outsideFile, 'utf8')).toBe('outside-secret');

    unlinkSync(linkedPath);
    const uploaded = await operationsByName.attachment_upload.handler(makeContext(), {
      filename: 'linked.txt',
      content_base64: payload.toString('base64'),
      auto_extract: false,
    }) as Record<string, unknown>;
    unlinkSync(linkedPath);
    symlinkSync(outsideFile, linkedPath);

    await expect(operationsByName.attachment_get.handler(makeContext(), {
      storage_path: uploaded.storage_path,
    })).rejects.toMatchObject({ code: 'storage_error' });
  });
});
