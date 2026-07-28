import { createHash } from 'crypto';
import { constants } from 'fs';
import { mkdir, open, realpath } from 'fs/promises';
import { basename, dirname, extname, relative, resolve, sep } from 'path';
import { importFromContent } from './import-file.ts';
import type { Operation, OperationContext } from './operations.ts';

const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
const ATTACHMENT_GET_MAX_BYTES = 10 * 1024 * 1024;
const ATTACHMENT_EXTRACT_MAX_TEXT_CHARS = 200_000;
const ATTACHMENT_EXTRACT_MAX_BYTES = 20 * 1024 * 1024;
const ATTACHMENT_DENY_EXT = new Set([
  '.html', '.htm', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.sh', '.bash', '.zsh', '.exe', '.dll', '.so', '.dylib', '.jar',
  '.php', '.pl', '.rb', '.ps1', '.bat', '.cmd',
]);

type OperationErrorLike = Error & { code: string };
type OperationErrorCtor = new (code: string, message: string, suggestion?: string) => OperationErrorLike;

export interface AttachmentOperationDependencies {
  OperationError: OperationErrorCtor;
  validatePageSlug: (slug: string) => void;
}

interface SourcePathRow {
  id: string;
  local_path: string | null;
}

interface AttachmentRow {
  source_id: string;
  page_slug: string | null;
  filename: string;
  storage_path: string;
  mime_type: string | null;
  size_bytes: number | string;
  content_hash: string;
  metadata: Record<string, unknown> | string | null;
  created_at?: string | Date;
}

interface ExtractedAttachmentText {
  text: string;
  method: string;
  truncated: boolean;
}

function resolveWriteSourceId(
  ctx: OperationContext,
  rawSourceId: unknown,
  OperationError: OperationErrorCtor,
): string {
  const sourceId = typeof rawSourceId === 'string' && rawSourceId.trim()
    ? rawSourceId.trim()
    : ctx.sourceId || 'default';
  if (ctx.remote === false) return sourceId;

  const fallbackSourceId = ctx.sourceId || 'default';
  const writeSources = ctx.auth?.writeSources?.length
    ? ctx.auth.writeSources
    : [fallbackSourceId];
  if (writeSources.includes(sourceId)) return sourceId;
  throw new OperationError('permission_denied', 'Attachment target is not writable by this caller');
}

function resolveReadSourceId(
  ctx: OperationContext,
  rawSourceId: unknown,
  OperationError: OperationErrorCtor,
): string {
  const sourceId = typeof rawSourceId === 'string' && rawSourceId.trim()
    ? rawSourceId.trim()
    : ctx.sourceId || 'default';
  if (ctx.remote === false) return sourceId;

  const allowedSources = ctx.auth?.allowedSources?.length
    ? ctx.auth.allowedSources
    : ctx.sourceId ? [ctx.sourceId] : [];
  if (allowedSources.includes(sourceId)) return sourceId;
  throw new OperationError('permission_denied', 'Attachment source is not readable by this caller');
}

async function getSourceLocalPath(
  ctx: OperationContext,
  sourceId: string,
  OperationError: OperationErrorCtor,
): Promise<string> {
  const rows = await ctx.engine.executeRaw<SourcePathRow>(
    'SELECT id, local_path FROM sources WHERE id = $1 AND archived = false LIMIT 1',
    [sourceId],
  );
  if (rows.length === 0) {
    throw new OperationError('invalid_params', `Unknown or archived source_id: ${sourceId}`);
  }
  const localPath = rows[0].local_path;
  if (!localPath) {
    throw new OperationError(
      'invalid_params',
      `source_id '${sourceId}' has no local_path; cannot store attachments via Git`,
    );
  }
  return localPath;
}

function safeRepoPath(repoPath: string, relPath: string, OperationError: OperationErrorCtor): string {
  const root = resolve(repoPath);
  const full = resolve(root, relPath);
  const rel = relative(root, full);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new OperationError('invalid_params', 'Attachment path escapes its source repository');
  }
  return full;
}

function pathIsWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`));
}

async function assertRealParentConfined(
  repoPath: string,
  fullPath: string,
  OperationError: OperationErrorCtor,
): Promise<void> {
  const [realRoot, realParent] = await Promise.all([
    realpath(repoPath),
    realpath(dirname(fullPath)),
  ]);
  if (!pathIsWithin(realRoot, realParent)) {
    throw new OperationError('storage_error', 'Attachment path traverses a symlink outside its source repository');
  }
}

async function readRegularFileNoFollow(
  fullPath: string,
  maxBytes: number,
  OperationError: OperationErrorCtor,
): Promise<Buffer> {
  let handle;
  try {
    handle = await open(fullPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const fileStat = await handle.stat();
    if (!fileStat.isFile() || fileStat.size > maxBytes) {
      throw new OperationError('storage_error', 'Attachment path is not a bounded regular file');
    }
    return await handle.readFile();
  } catch (error) {
    if (error instanceof OperationError) throw error;
    throw new OperationError('storage_error', 'Attachment path cannot be opened safely');
  } finally {
    await handle?.close();
  }
}

async function writeFileNoFollow(
  fullPath: string,
  content: string | Buffer,
  exclusive: boolean,
): Promise<void> {
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW |
    (exclusive ? constants.O_EXCL : constants.O_TRUNC);
  const handle = await open(fullPath, flags, 0o600);
  try {
    await handle.writeFile(content);
  } finally {
    await handle.close();
  }
}

function sanitizeAttachmentFilename(raw: unknown, OperationError: OperationErrorCtor): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new OperationError('invalid_params', 'filename must be a non-empty string');
  }
  let name = basename(raw.replace(/\\/g, '/')).normalize('NFC').trim();
  name = name.replace(/[\u0000-\u001f\u007f\u202e]/g, '');
  name = name.replace(/\s+/g, '-');
  name = Array.from(name)
    .map(ch => /[\p{L}\p{N}._-]/u.test(ch) ? ch : '-')
    .join('');
  name = name.replace(/-+/g, '-').replace(/\.{2,}/g, '.');
  name = name.replace(/^[.-]+/, '').replace(/[.-]+$/, '');
  if (!name) name = 'attachment';
  if (name.length > 180) {
    const ext = extname(name);
    const stem = ext ? name.slice(0, -ext.length) : name;
    name = stem.slice(0, Math.max(1, 180 - ext.length)) + ext;
  }
  const ext = extname(name).toLowerCase();
  if (ATTACHMENT_DENY_EXT.has(ext)) {
    throw new OperationError('invalid_params', `Attachment extension '${ext}' is not allowed`);
  }
  return name;
}

function decodeBase64Attachment(raw: unknown, OperationError: OperationErrorCtor): Buffer {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new OperationError('invalid_params', 'content_base64 must be a non-empty base64 string');
  }
  const compact = raw.replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)) {
    throw new OperationError('invalid_params', 'content_base64 is not valid base64');
  }
  const maxEncoded = Math.ceil(ATTACHMENT_MAX_BYTES / 3) * 4 + 4;
  if (compact.length > maxEncoded) {
    throw new OperationError('invalid_params', `Attachment exceeds ${ATTACHMENT_MAX_BYTES} bytes encoded limit`);
  }
  const content = Buffer.from(compact, 'base64');
  if (content.length === 0) {
    throw new OperationError('invalid_params', 'Decoded attachment is empty');
  }
  if (content.length > ATTACHMENT_MAX_BYTES) {
    throw new OperationError('invalid_params', `Attachment exceeds ${ATTACHMENT_MAX_BYTES} bytes limit`);
  }
  return content;
}

function inferAttachmentMime(
  filename: string,
  explicit: unknown,
  OperationError: OperationErrorCtor,
): string {
  if (typeof explicit === 'string' && explicit.trim()) {
    const mime = explicit.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i.test(mime)) {
      throw new OperationError('invalid_params', `Invalid mime_type: ${explicit}`);
    }
    return mime;
  }
  const mimeTypes: Record<string, string> = {
    '.pdf': 'application/pdf',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.csv': 'text/csv',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.json': 'application/json',
    '.xml': 'application/xml',
    '.yaml': 'application/yaml',
    '.yml': 'application/yaml',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.mp3': 'audio/mpeg',
    '.mp4': 'video/mp4',
    '.zip': 'application/zip',
  };
  return mimeTypes[extname(filename).toLowerCase()] || 'application/octet-stream';
}

function isProbablyTextMime(mimeType: string): boolean {
  return mimeType.startsWith('text/') || [
    'application/json',
    'application/xml',
    'application/yaml',
    'application/x-yaml',
    'application/sql',
  ].includes(mimeType);
}

function truncateExtractedText(text: string): { text: string; truncated: boolean } {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\u0000/g, '').trim();
  if (normalized.length <= ATTACHMENT_EXTRACT_MAX_TEXT_CHARS) {
    return { text: normalized, truncated: false };
  }
  return {
    text: normalized.slice(0, ATTACHMENT_EXTRACT_MAX_TEXT_CHARS).trimEnd(),
    truncated: true,
  };
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_match, value: string) => {
      const code = Number(value);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, value: string) => {
      const code = Number.parseInt(value, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    })
    .replace(/&amp;/g, '&');
}

function xmlToText(xml: string): string {
  return decodeXmlEntities(xml
    .replace(/<\/?w:p[^>]*>/g, '\n')
    .replace(/<\/?a:p[^>]*>/g, '\n')
    .replace(/<\/?row[^>]*>/g, '\n')
    .replace(/<\/?c[^>]*>/g, '\t')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+/g, '\n'));
}

async function commandStdout(args: string[], maxBytes = ATTACHMENT_EXTRACT_MAX_BYTES): Promise<string | null> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'ignore' });
    let timedOut = false;
    timeout = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, 30_000);
    timeout.unref?.();
    const chunks: Uint8Array[] = [];
    let total = 0;
    let exceeded = false;
    const reader = proc.stdout.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        exceeded = true;
        proc.kill();
        break;
      }
      chunks.push(value);
    }
    const exitCode = await proc.exited;
    if ((exitCode !== 0 && chunks.length === 0) || exceeded || timedOut) return null;
    return new TextDecoder('utf-8', { fatal: false }).decode(
      Buffer.concat(chunks.map(chunk => Buffer.from(chunk))),
    );
  } catch {
    return null;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function extractAttachmentText(
  fullPath: string,
  filename: string,
  mimeType: string,
  content: Buffer,
  suppliedText: unknown,
): Promise<ExtractedAttachmentText | null> {
  if (typeof suppliedText === 'string' && suppliedText.trim()) {
    return { ...truncateExtractedText(suppliedText), method: 'caller_supplied_extracted_text' };
  }
  if (content.length > ATTACHMENT_EXTRACT_MAX_BYTES) return null;

  const ext = extname(filename).toLowerCase();
  if (isProbablyTextMime(mimeType) || ['.txt', '.md', '.csv', '.json', '.xml', '.yaml', '.yml', '.sql'].includes(ext)) {
    const decoded = new TextDecoder('utf-8', { fatal: false }).decode(content);
    return { ...truncateExtractedText(decoded), method: 'plain_text_decode' };
  }
  if (ext === '.docx') {
    const xml = await commandStdout(['unzip', '-p', fullPath, 'word/document.xml']);
    if (xml) {
      const output = truncateExtractedText(xmlToText(xml));
      return output.text ? { ...output, method: 'docx_unzip_xml' } : null;
    }
  }
  if (ext === '.pptx') {
    const listing = await commandStdout(['unzip', '-Z1', fullPath]);
    const slidePaths = (listing || '')
      .split('\n')
      .filter(path => /^ppt\/slides\/slide\d+\.xml$/.test(path))
      .sort()
      .slice(0, 80);
    const parts: string[] = [];
    for (const slidePath of slidePaths) {
      const xml = await commandStdout(['unzip', '-p', fullPath, slidePath]);
      if (xml) parts.push(`\n## ${slidePath}\n${xmlToText(xml)}`);
    }
    if (parts.length) {
      const output = truncateExtractedText(parts.join('\n'));
      return output.text ? { ...output, method: 'pptx_unzip_xml' } : null;
    }
  }
  if (ext === '.xlsx') {
    const sharedXml = await commandStdout(['unzip', '-p', fullPath, 'xl/sharedStrings.xml']);
    const shared = sharedXml
      ? Array.from(sharedXml.matchAll(/<si[^>]*>([\s\S]*?)<\/si>/g))
        .map(match => xmlToText(match[1]).trim())
      : [];
    const listing = await commandStdout(['unzip', '-Z1', fullPath]);
    const sheetPaths = (listing || '')
      .split('\n')
      .filter(path => /^xl\/worksheets\/sheet\d+\.xml$/.test(path))
      .sort()
      .slice(0, 30);
    const parts: string[] = [];
    for (const sheetPath of sheetPaths) {
      const xml = await commandStdout(['unzip', '-p', fullPath, sheetPath]);
      if (!xml) continue;
      const values: string[] = [];
      for (const match of xml.matchAll(/<c[^>]*(?:t="([^"]+)")?[^>]*>[\s\S]*?<v>([\s\S]*?)<\/v>[\s\S]*?<\/c>/g)) {
        const raw = decodeXmlEntities(match[2]).trim();
        values.push(match[1] === 's' ? (shared[Number(raw)] ?? raw) : raw);
        if (values.length >= 5_000) break;
      }
      if (values.length) parts.push(`\n## ${sheetPath}\n${values.join('\t')}`);
    }
    if (parts.length) {
      const output = truncateExtractedText(parts.join('\n'));
      return output.text ? { ...output, method: 'xlsx_unzip_xml' } : null;
    }
  }
  if (ext === '.pdf') {
    const pdfText = await commandStdout(['pdftotext', '-layout', fullPath, '-']);
    if (pdfText) {
      const output = truncateExtractedText(pdfText);
      return output.text ? { ...output, method: 'pdftotext' } : null;
    }
  }
  return null;
}

function attachmentIndexSlug(hash: string, filename: string): string {
  const stem = basename(filename, extname(filename))
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return `raw-files/${hash.slice(0, 12)}${stem ? `-${stem}` : ''}`;
}

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

function buildAttachmentIndexMarkdown(opts: {
  title: string;
  filename: string;
  sourceId: string;
  pageSlug: string | null;
  storagePath: string;
  repoRelativePath: string;
  sha256: string;
  mimeType: string;
  sizeBytes: number;
  markdownPath: string;
  extractedText: string;
  extractionMethod: string;
  extractionTruncated: boolean;
}): string {
  const pageSlugLine = opts.pageSlug ? `linked_page: ${yamlScalar(opts.pageSlug)}\n` : '';
  return `---\n` +
    `title: ${yamlScalar(opts.title)}\n` +
    `source_id: ${yamlScalar(opts.sourceId)}\n` +
    `type: raw_attachment_text\n` +
    `status: active\n` +
    `tags: [raw-data, attachment, extracted-text]\n` +
    `original_filename: ${yamlScalar(opts.filename)}\n` +
    `storage_path: ${yamlScalar(opts.storagePath)}\n` +
    `source_file: ${yamlScalar(opts.repoRelativePath)}\n` +
    pageSlugLine +
    `mime_type: ${yamlScalar(opts.mimeType)}\n` +
    `size_bytes: ${opts.sizeBytes}\n` +
    `sha256: ${yamlScalar(opts.sha256)}\n` +
    `extraction_method: ${yamlScalar(opts.extractionMethod)}\n` +
    `extraction_truncated: ${opts.extractionTruncated ? 'true' : 'false'}\n` +
    `---\n\n` +
    `# ${opts.title}\n\n` +
    `Оригинальный файл: [${opts.filename}](${opts.markdownPath})\n\n` +
    `## Метаданные\n\n` +
    `- source_id: \`${opts.sourceId}\`\n` +
    `- storage_path: \`${opts.storagePath}\`\n` +
    `- mime_type: \`${opts.mimeType}\`\n` +
    `- size_bytes: ${opts.sizeBytes}\n` +
    `- sha256: \`${opts.sha256}\`\n` +
    `- extraction_method: \`${opts.extractionMethod}\`\n` +
    `- extraction_truncated: ${opts.extractionTruncated}\n\n` +
    `## Извлечённое содержимое\n\n` +
    `${opts.extractedText}\n`;
}

function parseMetadata(raw: AttachmentRow['metadata']): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return {};
}

export function createAttachmentOperations(deps: AttachmentOperationDependencies): Operation[] {
  const { OperationError, validatePageSlug } = deps;

  const attachmentUpload: Operation = {
    name: 'attachment_upload',
    description: 'Upload a raw attachment (PDF/XLSX/DOCX/image/etc.) into a GBrain source repository under _attachments/. The file bytes are passed as base64; the tool writes the file to Git-backed storage, records metadata, and can create/vectorize a Markdown text index page from extracted or caller-supplied text.',
    params: {
      filename: { type: 'string', required: true, description: 'Original filename. Path separators are stripped; unsafe characters are sanitized.' },
      content_base64: { type: 'string', required: true, description: 'Base64-encoded file bytes. Data URLs are accepted.' },
      source_id: { type: 'string', required: false, description: 'Target GBrain source. Remote callers may only use sources in their federated_write list.' },
      page_slug: { type: 'string', required: false, description: 'Optional page slug to associate the file with.' },
      mime_type: { type: 'string', required: false, description: 'Optional MIME type. If omitted, inferred from extension.' },
      auto_extract: { type: 'boolean', required: false, description: 'Create and vectorize a Markdown index page from extractable file text. Default true.' },
      extracted_text: { type: 'string', required: false, description: 'Optional caller-supplied text/OCR. Used when server-side extraction is unavailable or insufficient.' },
    },
    mutating: true,
    scope: 'write',
    handler: async (ctx, params) => {
      const sourceId = resolveWriteSourceId(ctx, params.source_id, OperationError);
      const filename = sanitizeAttachmentFilename(params.filename, OperationError);
      if (ctx.dryRun) {
        return { dry_run: true, action: 'attachment_upload', source_id: sourceId, filename };
      }

      const repoPath = await getSourceLocalPath(ctx, sourceId, OperationError);
      const content = decodeBase64Attachment(params.content_base64, OperationError);
      const mimeType = inferAttachmentMime(filename, params.mime_type, OperationError);
      const pageSlug = typeof params.page_slug === 'string' && params.page_slug.trim()
        ? params.page_slug.trim()
        : null;
      if (pageSlug) validatePageSlug(pageSlug);

      const sha256 = createHash('sha256').update(content).digest('hex');
      const repoRelativePath = `_attachments/${sha256.slice(0, 12)}-${filename}`;
      const fullPath = safeRepoPath(repoPath, repoRelativePath, OperationError);
      await mkdir(dirname(fullPath), { recursive: true });
      await assertRealParentConfined(repoPath, fullPath, OperationError);
      try {
        await writeFileNoFollow(fullPath, content, true);
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
        const existing = await readRegularFileNoFollow(fullPath, ATTACHMENT_MAX_BYTES, OperationError);
        const existingHash = createHash('sha256').update(existing).digest('hex');
        if (existingHash !== sha256) {
          throw new OperationError('storage_error', 'Existing attachment path failed its content-integrity check');
        }
      }
      const sizeBytes = content.length;
      const storagePath = `${sourceId}/${repoRelativePath}`;
      const markdownPath = pageSlug && pageSlug.includes('/')
        ? `${'../'.repeat(pageSlug.split('/').length - 1)}${repoRelativePath}`
        : repoRelativePath;

      let indexedPage: Record<string, unknown> | null = null;
      let extraction: ExtractedAttachmentText | null = null;
      if (params.auto_extract !== false) {
        extraction = await extractAttachmentText(
          fullPath,
          filename,
          mimeType,
          content,
          params.extracted_text,
        );
        if (extraction?.text) {
          const indexSlug = attachmentIndexSlug(sha256, filename);
          const indexRelPath = `${indexSlug}.md`;
          const indexFullPath = safeRepoPath(repoPath, indexRelPath, OperationError);
          const indexMarkdownPath = indexSlug.includes('/')
            ? `${'../'.repeat(indexSlug.split('/').length - 1)}${repoRelativePath}`
            : repoRelativePath;
          const indexMarkdown = buildAttachmentIndexMarkdown({
            title: `Raw attachment: ${filename}`,
            filename,
            sourceId,
            pageSlug,
            storagePath,
            repoRelativePath,
            sha256,
            mimeType,
            sizeBytes,
            markdownPath: indexMarkdownPath,
            extractedText: extraction.text,
            extractionMethod: extraction.method,
            extractionTruncated: extraction.truncated,
          });
          await mkdir(dirname(indexFullPath), { recursive: true });
          await assertRealParentConfined(repoPath, indexFullPath, OperationError);
          try {
            await writeFileNoFollow(indexFullPath, indexMarkdown, false);
          } catch {
            throw new OperationError('storage_error', 'Attachment index path cannot be written safely');
          }
          const { isAvailable } = await import('./ai/gateway.ts');
          const importResult = await importFromContent(ctx.engine, indexSlug, indexMarkdown, {
            noEmbed: !isAvailable('embedding'),
            sourceId,
            filename: basename(indexRelPath),
            sourcePath: indexRelPath,
            remote: ctx.remote !== false,
            source_kind: 'attachment',
            source_uri: storagePath,
            ingested_via: ctx.remote === false ? 'local:attachment_upload' : 'mcp:attachment_upload',
          });
          indexedPage = {
            slug: indexSlug,
            repo_relative_path: indexRelPath,
            status: importResult.status,
            chunks: importResult.chunks,
            error: importResult.error ?? null,
            extraction_method: extraction.method,
            extraction_truncated: extraction.truncated,
          };
        }
      }

      const metadata = {
        repo_relative_path: repoRelativePath,
        uploaded_via: ctx.remote === false ? 'local:attachment_upload' : 'mcp:attachment_upload',
        indexed_page_slug: indexedPage?.slug ?? null,
        extraction_method: extraction?.method ?? null,
        extraction_truncated: extraction?.truncated ?? null,
      };
      await ctx.engine.executeRaw(
        `INSERT INTO files
           (source_id, page_slug, filename, storage_path, mime_type, size_bytes, content_hash, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
         ON CONFLICT (storage_path) DO UPDATE SET
           source_id = EXCLUDED.source_id,
           page_slug = EXCLUDED.page_slug,
           filename = EXCLUDED.filename,
           mime_type = EXCLUDED.mime_type,
           size_bytes = EXCLUDED.size_bytes,
           content_hash = EXCLUDED.content_hash,
           metadata = EXCLUDED.metadata`,
        [
          sourceId,
          pageSlug,
          filename,
          storagePath,
          mimeType,
          sizeBytes,
          sha256,
          JSON.stringify(metadata),
        ],
      );

      return {
        status: 'uploaded',
        source_id: sourceId,
        filename,
        storage_path: storagePath,
        repo_relative_path: repoRelativePath,
        size_bytes: sizeBytes,
        sha256,
        mime_type: mimeType,
        markdown_link: `[${filename}](${markdownPath})`,
        indexed_page: indexedPage,
        extraction: extraction
          ? { method: extraction.method, truncated: extraction.truncated, chars: extraction.text.length }
          : null,
      };
    },
  };

  const attachmentList: Operation = {
    name: 'attachment_list',
    description: 'List raw attachments stored for a GBrain source, optionally filtered by page_slug.',
    params: {
      source_id: { type: 'string', required: false },
      page_slug: { type: 'string', required: false },
      limit: { type: 'number', required: false, default: 50 },
    },
    scope: 'read',
    handler: async (ctx, params) => {
      const sourceId = resolveReadSourceId(ctx, params.source_id, OperationError);
      const pageSlug = typeof params.page_slug === 'string' && params.page_slug.trim()
        ? params.page_slug.trim()
        : null;
      if (pageSlug) validatePageSlug(pageSlug);
      const rawLimit = Number(params.limit ?? 50);
      const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(100, Math.floor(rawLimit))) : 50;
      if (pageSlug) {
        return ctx.engine.executeRaw<AttachmentRow>(
          `SELECT source_id, page_slug, filename, storage_path, mime_type, size_bytes,
                  content_hash, metadata, created_at
             FROM files
            WHERE source_id = $1 AND page_slug = $2
            ORDER BY created_at DESC
            LIMIT $3`,
          [sourceId, pageSlug, limit],
        );
      }
      return ctx.engine.executeRaw<AttachmentRow>(
        `SELECT source_id, page_slug, filename, storage_path, mime_type, size_bytes,
                content_hash, metadata, created_at
           FROM files
          WHERE source_id = $1
          ORDER BY created_at DESC
          LIMIT $2`,
        [sourceId, limit],
      );
    },
  };

  const attachmentGet: Operation = {
    name: 'attachment_get',
    description: 'Read a stored raw attachment as base64. Intended for small/medium files; larger files should be retrieved through Git/portal download.',
    params: {
      storage_path: { type: 'string', required: true },
    },
    scope: 'read',
    handler: async (ctx, params) => {
      const storagePath = params.storage_path;
      if (
        typeof storagePath !== 'string' ||
        !storagePath.includes('/') ||
        storagePath.includes('..') ||
        storagePath.startsWith('/')
      ) {
        throw new OperationError('invalid_params', 'Invalid storage_path');
      }
      const sourceId = resolveReadSourceId(ctx, storagePath.split('/')[0], OperationError);
      const rows = await ctx.engine.executeRaw<AttachmentRow>(
        `SELECT source_id, page_slug, filename, storage_path, mime_type, size_bytes,
                content_hash, metadata
           FROM files
          WHERE storage_path = $1 AND source_id = $2
          LIMIT 1`,
        [storagePath, sourceId],
      );
      if (rows.length === 0) {
        throw new OperationError('storage_error', 'Attachment not found');
      }
      const row = rows[0];
      const sizeBytes = Number(row.size_bytes ?? 0);
      if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > ATTACHMENT_GET_MAX_BYTES) {
        throw new OperationError(
          'invalid_params',
          `Attachment exceeds the attachment_get limit of ${ATTACHMENT_GET_MAX_BYTES} bytes`,
        );
      }
      const repoPath = await getSourceLocalPath(ctx, sourceId, OperationError);
      const metadata = parseMetadata(row.metadata);
      const relPath = typeof metadata.repo_relative_path === 'string'
        ? metadata.repo_relative_path
        : storagePath.split('/').slice(1).join('/');
      const fullPath = safeRepoPath(repoPath, relPath, OperationError);
      await assertRealParentConfined(repoPath, fullPath, OperationError);
      const content = await readRegularFileNoFollow(fullPath, ATTACHMENT_GET_MAX_BYTES, OperationError);
      const actualHash = createHash('sha256').update(content).digest('hex');
      if (content.length !== sizeBytes || actualHash !== row.content_hash) {
        throw new OperationError('storage_error', 'Attachment failed its size/hash integrity check');
      }
      return {
        source_id: sourceId,
        page_slug: row.page_slug,
        filename: row.filename,
        storage_path: row.storage_path,
        mime_type: row.mime_type,
        size_bytes: sizeBytes,
        sha256: row.content_hash,
        content_base64: content.toString('base64'),
      };
    },
  };

  return [attachmentUpload, attachmentList, attachmentGet];
}
