import { createHash } from 'node:crypto';
import { constants, openSync, closeSync, fstatSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, normalize } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { loadPageFileBootstrap, loadPageFileStartupBootstrap, pageFileBootstrapAnchorSchema, requirePageFilePilotAdmission } from '../core/page-file-bootstrap.ts';
import type { PageFileRuntimeEnrollment } from '../core/page-file-runtime.ts';
import type { OperationContext } from '../core/operations.ts';

const text = z.string().min(1).max(4096), digest = z.string().regex(/^[a-f0-9]{64}$/);
const anchorSchema = z.strictObject({ operatorPath: text, operatorSha256: digest });
const commonContract = { mode: z.enum(['offline-verification', 'production-pilot']),
  bootstrap: pageFileBootstrapAnchorSchema, enrollmentCredentialPath: text, enrollmentCredentialSha256: digest };
const contractSchema = z.discriminatedUnion('version', [
  z.strictObject({ version: z.literal(1), ...commonContract, reviewedPath: text, reviewedSha256: digest }),
  z.strictObject({ version: z.literal(2), ...commonContract, sourceIds: z.array(text).min(1).max(256)
    .refine(ids => new Set(ids).size === ids.length) }),
]);
const reviewedSchema = z.strictObject({ hostManifestSha256: digest, source: text, slug: text, pageId: text,
  revision: text, canonicalRoot: text, relativePath: text, rawSha256: digest });
const invalid = () => new Error('page_file_operator_invalid');
function local(ctx: { remote?: unknown }) { if (ctx.remote !== false) throw new Error('page_file_operator_denied'); }
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const identity = (s: import('node:fs').BigIntStats) => [s.dev,s.ino,s.uid,s.gid,s.mode,s.nlink,s.size,s.mtimeNs,s.ctimeNs].join(':');
/** Operator-only reader; bootstrap's private reader intentionally remains private.
 * Same no-follow, bounded descriptor/path/ancestor identity contract. */
function protectedFile(path: string) {
  if (!isAbsolute(path) || normalize(path) !== path || realpathSync(path) !== path) throw invalid();
  const uid = process.getuid?.(); if (uid === undefined) throw invalid();
  const parents: string[] = [];
  for (let p = dirname(path); ; p = dirname(p)) {
    const s = lstatSync(p,{bigint:true});
    if (!s.isDirectory() || (s.mode & 0o022n) !== 0n || (s.uid !== 0n && s.uid !== BigInt(uid))) throw invalid();
    parents.push([p,s.dev,s.ino,s.uid,s.gid,s.mode].join(':'));
    if (p === dirname(p)) break;
  }
  const fd = openSync(path,constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const s = fstatSync(fd,{bigint:true});
    if (!s.isFile() || s.uid !== BigInt(uid) || s.nlink !== 1n || (s.mode & 0o7777n) !== 0o400n || s.size > 1048576n) throw invalid();
    const bytes = readFileSync(fd), key = identity(s);
    if (key !== identity(fstatSync(fd,{bigint:true})) || key !== identity(lstatSync(path,{bigint:true}))) throw invalid();
    return { bytes, fingerprint: [key,...parents,sha(bytes)].join('|') };
  } finally { closeSync(fd); }
}
const authorized = new WeakSet<object>();
// Private policy metadata cannot be supplied through a request or serialized capability.
const sourcePolicies = new WeakMap<object, { sourceIds: readonly string[]; policy: string;
  manifest: import('../core/page-file-host.ts').PageFileHostManifest; manifestSha256: string }>();
/** Trusted local file loader, not an MCP operation or worker capability. The path
 * override is for offline fixtures; the executable has no path/env override. */
export function loadPageFileOperator(ctx: { remote?: unknown }, path = '/etc/gbrain/page-file-operator-anchor.json') {
  local(ctx);
  try {
    const anchorFile = protectedFile(path), anchor = anchorSchema.parse(JSON.parse(anchorFile.bytes.toString()));
    const file = protectedFile(anchor.operatorPath);
    if (sha(file.bytes) !== anchor.operatorSha256) throw invalid();
    const contract = contractSchema.parse(JSON.parse(file.bytes.toString()));
    const bootstrap = loadPageFileBootstrap(contract.bootstrap);
    if (bootstrap.status === 'disabled' || bootstrap.status !== contract.mode) throw invalid();
    const reviewedFile = contract.version === 1 ? protectedFile(contract.reviewedPath) : undefined;
    if (contract.version === 1 && (!reviewedFile || sha(reviewedFile.bytes) !== contract.reviewedSha256)) throw invalid();
    const reviewed = reviewedFile ? Object.freeze(reviewedSchema.parse(JSON.parse(reviewedFile.bytes.toString()))) : undefined;
    if (bootstrap.status === 'production-pilot') {
      const approved = requirePageFilePilotAdmission(bootstrap.admission);
      if (contract.version === 1) {
        if (!reviewed || !('source' in approved) || reviewed.source !== approved.source || reviewed.slug !== approved.slug) throw invalid();
      } else {
        // V1 NEVER means source-wide. Unknown/new admission shapes fail closed.
        if (approved.version !== 2 || contract.sourceIds.some(id => !approved.sources.includes(id))) throw invalid();
      }
    }
    if ((reviewed && reviewed.hostManifestSha256 !== bootstrap.contract.expected.manifestSha256)
      || contract.enrollmentCredentialPath === bootstrap.contract.credentialPath
      || contract.enrollmentCredentialSha256 === bootstrap.contract.credentialSha256) throw invalid();
    const manifestFile = protectedFile(bootstrap.contract.manifestPath);
    if (sha(manifestFile.bytes) !== bootstrap.contract.expected.manifestSha256) throw invalid();
    bootstrap.revalidate();
    const manifest = JSON.parse(manifestFile.bytes.toString());
    const roots = [...manifest.indexedRoots, ...manifest.roots.map((r: any) => r.directory)];
    if (contract.version === 2 && contract.sourceIds.some(id => !manifest.roots.some((r: any) => r.sourceId === id))) throw invalid();
    for (const p of [path,anchor.operatorPath,...(contract.version === 1 ? [contract.reviewedPath] : []),contract.enrollmentCredentialPath])
      if (roots.some((r: any) => p === r.path || p.startsWith(r.path === '/' ? '/' : r.path + '/'))) throw invalid();
    const revalidate = () => {
      try {
        if (protectedFile(path).fingerprint !== anchorFile.fingerprint
          || protectedFile(anchor.operatorPath).fingerprint !== file.fingerprint
          || (contract.version === 1 && protectedFile(contract.reviewedPath).fingerprint !== reviewedFile!.fingerprint)) throw invalid();
        bootstrap.revalidate();
      } catch { throw invalid(); }
    };
    const loaded = Object.freeze({ reviewed, revalidate,
      verifyStartup() {
        revalidate(); const startup = loadPageFileStartupBootstrap();
        if (startup.status === 'disabled' || startup.status !== bootstrap.status || !isDeepStrictEqual(startup.contract,bootstrap.contract)) throw invalid();
        if (startup.status === 'production-pilot' && !isDeepStrictEqual(requirePageFilePilotAdmission(startup.admission), requirePageFilePilotAdmission(bootstrap.admission))) throw invalid();
      },
      async enrollment(caller: { remote?: unknown }, observation?: PageFileRuntimeEnrollment['reviewed']): Promise<PageFileRuntimeEnrollment> {
        local(caller);
        try {
          revalidate();
          const target = contract.version === 1 ? reviewed : observation && reviewedSchema.parse(observation);
          if (!target || (contract.version === 1 && observation) || (contract.version === 2
            && (!contract.sourceIds.includes(target.source) || target.hostManifestSha256 !== bootstrap.contract.expected.manifestSha256
              || !manifest.roots.some((r: any) => r.sourceId === target.source && r.directory.path === target.canonicalRoot)))) throw invalid();
          const secret = protectedFile(contract.enrollmentCredentialPath);
          if (sha(secret.bytes) !== contract.enrollmentCredentialSha256) throw invalid();
          const fingerprint = secret.fingerprint; secret.bytes.fill(0);
          const roles = bootstrap.contract.sqlAuthority.roles;
          return { reviewed: {...target}, authority: {
            mode:bootstrap.status, admission:bootstrap.admission, adapterRole:roles.adapter, credentialReference:contract.enrollmentCredentialPath,
            expected:{role:roles.enrollment,ordinaryRole:roles.ordinary,database:bootstrap.contract.expected.database},
            sqlAuthority:{...bootstrap.contract.sqlAuthority,role:roles.enrollment,database:bootstrap.contract.expected.database},
            async revalidate() { revalidate(); const s=protectedFile(contract.enrollmentCredentialPath); try { if(s.fingerprint!==fingerprint) throw invalid(); } finally {s.bytes.fill(0);} },
            async resolveCredential(reference) {
              try {
                revalidate(); if(reference!==contract.enrollmentCredentialPath) throw invalid();
                const s=protectedFile(reference);
                try { if(s.fingerprint!==fingerprint) throw invalid(); const value=s.bytes.toString().trim(); if(!/^postgres(?:ql)?:\/\//.test(value)) throw invalid(); return value; }
                finally {s.bytes.fill(0);}
              } catch {throw invalid();}
            },
          }};
        } catch { throw invalid(); }
      },
    });
    authorized.add(loaded);
    if (contract.version === 2) sourcePolicies.set(loaded, { sourceIds: Object.freeze([...contract.sourceIds]),
      policy: sha(file.bytes), manifest, manifestSha256: bootstrap.contract.expected.manifestSha256 });
    return loaded;
  } catch { throw invalid(); }
}

type Operator = ReturnType<typeof loadPageFileOperator>;
const batchSchema = z.strictObject({ source: text, limit: z.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).max(16384).regex(/^[A-Za-z0-9_-]+$/).optional() });
const cursorSchema = z.strictObject({ version: z.literal(1), policy: digest, source: text, after: text });
type InventoryRow = { id: string | number; source_id: string; slug: string; source_path: string | null;
  page_kind: string; deleted_at: unknown; write_revision: string };
const itemReasons = new Set(['pending_recovery','sync_required','page_file_root_sync_required','ineligible_page',
  'missing_file','unsafe_file','invalid_binding','path_collision','file_too_large','invalid_utf8','file_changed',
  'binding_changed','page_file_binding_changed','page_file_enrollment_stale','page_file_gate_busy',
  'page_file_root_gate_unavailable','page_file_inventory_limit']);

/** Bounded local sweep, not an authorization or recovery service. Cursors are
 * progress only, bound to the protected policy, never authorization. Start again
 * without a cursor after a completed sweep to discover new or previously skipped
 * pages (including slugs sorting before the old cursor). */
async function runSourceBatch(ctx: Pick<OperationContext,'engine'|'config'|'remote'>, operator: Operator,
  action: 'inventory' | 'reconcile', input: unknown) {
  const policy = sourcePolicies.get(operator);
  const options = batchSchema.parse(input);
  if (!policy || !policy.sourceIds.includes(options.source)) throw invalid();
  let after = '';
  if (options.cursor) {
    const cursor = cursorSchema.parse(JSON.parse(Buffer.from(options.cursor,'base64url').toString('utf8')));
    if (cursor.policy !== policy.policy || cursor.source !== options.source) throw invalid();
    after = cursor.after;
  }
  const source = options.source;
  const root = policy.manifest.roots.find(r => r.sourceId === source);
  if (!root) throw invalid();
  const { resolvePageFileRuntime, enrollPageFileRuntime } = await import('../core/page-file-runtime.ts');
  const { resolveExistingPageFileBinding, pageFileMappingIdentity } = await import('../core/page-file-binding.ts');
  const { assertPageFileRootClean } = await import('../core/page-file-root-transition.ts');
  const rows = await ctx.engine.executeRaw<InventoryRow>(`/* source-enrollment-inventory */
    SELECT id::text AS id,source_id,slug,source_path,page_kind,deleted_at,write_revision FROM pages
    WHERE source_id=$1 AND slug COLLATE "C" > $2 COLLATE "C" ORDER BY slug COLLATE "C" LIMIT $3`,
    [source,after,options.limit+1]);
  if (rows.length > options.limit+1) throw invalid();
  // Reject duplicate/out-of-order/foreign rows rather than trusting a transport
  // that could otherwise skip work or select a different authorization scope.
  let previous = after;
  for (const row of rows) {
    if (row.source_id !== source || !text.safeParse(row.slug).success
      || Buffer.compare(Buffer.from(row.slug),Buffer.from(previous)) <= 0) throw invalid();
    previous = row.slug;
  }
  const items: { source: string; slug: string; status: string; reason?: string }[] = [];
  for (const row of rows.slice(0,options.limit)) {
    operator.verifyStartup();
    const slug = row.slug;
    try {
      const [existing] = await ctx.engine.executeRaw<{pending_op_id:string|null}>(
        'SELECT pending_op_id FROM page_file_bindings WHERE source_id=$1 AND slug=$2',[source,slug]);
      if (existing?.pending_op_id) throw new Error('pending_recovery');
      if (existing) {
        // Never call enroll on an existing binding: generation>0 is normal.
        const runtime = await resolvePageFileRuntime(ctx,source,slug);
        if (!runtime) throw new Error('binding_changed');
        await runtime.pages.get(source,slug,()=>{});
        items.push({source,slug,status:'verified'});
      } else if (row.deleted_at !== null || row.page_kind !== 'markdown') {
        items.push({source,slug,status:'ineligible',reason:row.deleted_at !== null ? 'deleted_page' : 'non_markdown'});
      } else {
        // Preliminary refusal only; checked runtime repeats this under its gate.
        assertPageFileRootClean({root:root.directory.path,lockDirectory:policy.manifest.lock.path,topology:policy.manifest.topology});
        const pending = await ctx.engine.executeRaw(`SELECT binding_id FROM page_file_bindings
          WHERE canonical_root=$1 AND pending_op_id IS NOT NULL LIMIT 1`,[root.directory.path]);
        if (pending.length) throw new Error('pending_recovery');
        // Complete collision inventory is mandatory. Never truncate it and claim
        // uniqueness. These hard caps bound the operator observation; the core
        // reobserves independently under its existing exclusive root + row locks.
        const sources = await ctx.engine.executeRaw<{id:string;local_path:string|null}>('SELECT id, local_path FROM sources LIMIT 1025');
        const paths = await ctx.engine.executeRaw<{pageId:string;sourceId:string;sourcePath:string}>(
          `SELECT id::text AS "pageId", source_id AS "sourceId", COALESCE(source_path, slug || '.md') AS "sourcePath" FROM pages WHERE deleted_at IS NULL LIMIT 10001`);
        if (sources.length > 1024 || paths.length > 10000) throw new Error('page_file_inventory_limit');
        if (sources.find(s=>s.id===source)?.local_path !== root.directory.path) throw new Error('binding_changed');
        const globalRepoPath = await ctx.engine.getConfig('sync.repo_path');
        const binding = await resolveExistingPageFileBinding({brainId:policy.manifest.brainId,sourceId:source,slug,
          pageId:String(row.id),sourcePath:row.source_path,sources,otherPagePaths:paths,globalRepoPath,
          configGeneration:pageFileMappingIdentity({sourceId:source,sources,globalRepoPath,mappingGeneration:root.mappingGeneration})});
        operator.revalidate();
        if (binding.canonicalRoot !== root.directory.path) throw new Error('binding_changed');
        if (action === 'inventory') {
          // Path/hash observations do NOT prove parser/index equivalence. Preview
          // must never call these eligible: final proof belongs to checked enroll.
          items.push({source,slug,status:'pending_enrollment',reason:'checked_enrollment_required'});
        } else {
          const reviewed = {hostManifestSha256:policy.manifestSha256,source,slug,pageId:String(row.id),
            revision:row.write_revision,canonicalRoot:binding.canonicalRoot,relativePath:binding.relativePath,rawSha256:binding.rawSha256};
          await enrollPageFileRuntime(ctx,source,slug,await operator.enrollment(ctx,reviewed));
          const runtime = await resolvePageFileRuntime(ctx,source,slug);
          if (!runtime) throw new Error('binding_changed');
          await runtime.pages.get(source,slug,()=>{});
          items.push({source,slug,status:'enrolled'});
        }
      }
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (!itemReasons.has(code)) throw invalid();
      items.push({source,slug,status:'blocked',reason:code});
    }
    operator.revalidate();
  }
  operator.verifyStartup();
  const nextCursor = rows.length > options.limit ? Buffer.from(JSON.stringify({version:1,policy:policy.policy,
    source,after:items[items.length-1]!.slug})).toString('base64url') : null;
  return {status:'complete',source,items,nextCursor};
}

/** Legacy v1 stays exact-page; v2 explicitly enables source inventory/reconcile.
 * No content edits, migration, recovery, or background enrollment. */
export async function runPageFileOperator(ctx: Pick<OperationContext,'engine'|'config'|'remote'>, operator: Operator, action: string, options?: unknown) {
  local(ctx);
  try {
    if (!authorized.has(operator) || !['status','verify','enroll','inventory','reconcile'].includes(action) || ctx.config.page_file_runtime?.mode === 'production') throw invalid();
    operator.verifyStartup();
    const { hasPageFileRuntimeCandidate, enrollPageFileRuntime, resolvePageFileRuntime } = await import('../core/page-file-runtime.ts');
    if (!await hasPageFileRuntimeCandidate(ctx.engine)) throw invalid();
    if (action === 'inventory' || action === 'reconcile') return await runSourceBatch(ctx,operator,action,options);
    if (options !== undefined || !operator.reviewed) throw invalid();
    const {source,slug} = operator.reviewed;
    if (action === 'enroll') {
      const result = await enrollPageFileRuntime(ctx,source,slug,await operator.enrollment(ctx));
      operator.revalidate();
      // Exact target readback through existing private adapter, never raw content output.
      const runtime = await resolvePageFileRuntime(ctx,source,slug);
      if (!runtime) throw invalid();
      await runtime.pages.get(source,slug,()=>{});
      return {status:result.status};
    }
    // SQL observation does not acquire authority, repair or choose a recovery winner.
    const [binding] = await ctx.engine.executeRaw<{pending_op_id:string|null}>('SELECT pending_op_id FROM page_file_bindings WHERE source_id=$1 AND slug=$2',[source,slug]);
    operator.revalidate();
    if (!binding) return {status:'not_enrolled'};
    if (binding.pending_op_id) return {status:'pending_recovery'};
    const runtime = await resolvePageFileRuntime(ctx,source,slug);
    if (!runtime) throw invalid();
    await runtime.pages.get(source,slug,()=>{});
    operator.revalidate();
    return {status:'verified'};
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    if (['pending_recovery','sync_required','page_file_root_sync_required'].includes(code)) return {status:code};
    throw invalid();
  }
}

export const PAGE_FILE_OPERATOR_HELP = 'Usage: bun src/commands/page-file-operator.ts <status|verify|enroll>\n       bun src/commands/page-file-operator.ts <inventory|reconcile> <source> [limit] [cursor]\nLocal only; fixed /etc/gbrain/page-file-operator-anchor.json. V1: pinned page. V2: protected source policy. Limit 1..100 (default 25). Repeat without cursor after completing a sweep to discover future pages. No content edits, migrations or automatic recovery.';
if (import.meta.main) {
  const args=process.argv.slice(2);
  const sourceAction = args[0] === 'inventory' || args[0] === 'reconcile';
  const batch = sourceAction ? batchSchema.safeParse({source:args[1],
    ...(args[2] === undefined ? {} : {limit:/^[1-9][0-9]*$/.test(args[2]) ? Number(args[2]) : NaN}),
    ...(args[3] === undefined ? {} : {cursor:args[3]})}) : undefined;
  if (args.length===1 && args[0]==='--help') console.log(PAGE_FILE_OPERATOR_HELP);
  else if (sourceAction ? (args.length<2 || args.length>4 || !batch?.success) : (args.length!==1 || !['status','verify','enroll'].includes(args[0]))) { console.error(PAGE_FILE_OPERATOR_HELP); process.exit(2); }
  else {
    // Ordinary config remains ordinary. Enrollment credentials are never added
    // to shared config, environment, workers, engine constructors or MCP context.
    let engine: import('../core/postgres-engine.ts').PostgresEngine | undefined;
    try {
      const operator=loadPageFileOperator({remote:false}); operator.verifyStartup();
      const {loadConfig}=await import('../core/config.ts'); const config=loadConfig();
      if (!config || config.engine!=='postgres') throw invalid();
      const {PostgresEngine}=await import('../core/postgres-engine.ts'); engine=new PostgresEngine();
      await engine.connect(config);
      const result=await runPageFileOperator({engine,config,remote:false},operator,args[0],batch?.success ? batch.data : undefined);
      await engine.disconnect(); engine=undefined;
      console.log(JSON.stringify(result));
    } catch {
      try {await engine?.disconnect();} catch { /* only fixed redacted error below */ }
      console.error('page_file_operator_failed'); process.exit(1);
    }
  }
}
