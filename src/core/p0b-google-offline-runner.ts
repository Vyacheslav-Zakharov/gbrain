import { parseP0BGoogleReconcilerLimits, type P0BGoogleReconcilerReceipt } from './p0b-google-reconciler.ts';
import { withP0BGoogleCredential, type P0BGoogleCredentialStore } from './p0b-google-credential.ts';
import { P0B_GOOGLE_RUNTIME_EXECUTION_STATE } from './p0b-google-credential.ts';

export const P0B_GOOGLE_RUNNER_ACTION = 'P0B_GOOGLE_RECONCILE_FIXED' as const;
export const P0B_GOOGLE_RUNNER_CONTRACT = Object.freeze({
  schema_version: 1,
  action: P0B_GOOGLE_RUNNER_ACTION,
  lifecycle: 'RECONCILING_ONLY',
  lease: 'PERSISTED_FENCED_AUTHORITY_REQUIRED',
  candidate_binding: 'EXACT_COMMIT_AND_PACKAGE_OWN_BYTES',
  activation: 'UNFINALIZED_NOEXEC',
  rollback: 'UNFINALIZED_NOEXEC',
} as const);

const REQUEST_KEYS = [
  'schema_version', 'action', 'candidate_commit_sha', 'package_root_sha256', 'runner_sha256',
  'provider_sha256', 'state_fingerprint', 'checkpoint_revision', 'lease_id', 'nonce', 'limits',
] as const;
const BYTES_KEYS = ['candidate_commit_sha', 'package_root_sha256', 'runner_sha256', 'provider_sha256'] as const;
const SHA256_RE = /^[a-f0-9]{64}$/;
const COMMIT_RE = /^[a-f0-9]{40}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{7,127}$/;
const NONCE_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{31,127}$/;
const FENCE_RE = /^fence-[0-9]{20}$/;

function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!plain(value)) throw new Error('P0B_RUNNER_INVALID');
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error('P0B_RUNNER_INVALID');
  }
  return value;
}

function parseRequest(value: unknown) {
  const request = exact(value, REQUEST_KEYS);
  if (request.schema_version !== 1 || request.action !== P0B_GOOGLE_RUNNER_ACTION
    || typeof request.candidate_commit_sha !== 'string' || !COMMIT_RE.test(request.candidate_commit_sha)
    || typeof request.package_root_sha256 !== 'string' || !SHA256_RE.test(request.package_root_sha256)
    || typeof request.runner_sha256 !== 'string' || !SHA256_RE.test(request.runner_sha256)
    || typeof request.provider_sha256 !== 'string' || !SHA256_RE.test(request.provider_sha256)
    || typeof request.state_fingerprint !== 'string' || !SHA256_RE.test(request.state_fingerprint)
    || typeof request.checkpoint_revision !== 'string' || !SHA256_RE.test(request.checkpoint_revision)
    || typeof request.lease_id !== 'string' || !ID_RE.test(request.lease_id)
    || typeof request.nonce !== 'string' || !NONCE_RE.test(request.nonce)) {
    throw new Error('P0B_RUNNER_INVALID');
  }
  return Object.freeze({
    ...request,
    limits: parseP0BGoogleReconcilerLimits(request.limits),
  }) as any;
}

function assertExactBytes(request: any, value: unknown): void {
  const trusted = exact(value, BYTES_KEYS);
  for (const key of BYTES_KEYS) {
    if (trusted[key] !== request[key]) throw new Error('P0B_EXACT_BYTES_MISMATCH');
  }
}

function now(dependencies: any): number {
  let value: unknown;
  try { value = dependencies.clock.now_epoch_ms.call(dependencies.clock); } catch { throw new Error('P0B_DEADLINE'); }
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error('P0B_DEADLINE');
  return value as number;
}

function cancelled(dependencies: any): boolean {
  let value: unknown;
  try { value = dependencies.cancellation.is_cancelled.call(dependencies.cancellation); } catch { throw new Error('P0B_CANCELLED'); }
  if (typeof value !== 'boolean') throw new Error('P0B_CANCELLED');
  return value;
}

function bounded(request: any, dependencies: any): void {
  if (cancelled(dependencies)) throw new Error('P0B_CANCELLED');
  if (now(dependencies) >= request.limits.deadline_epoch_ms) throw new Error('P0B_DEADLINE');
}

export interface P0BGoogleOfflineRunnerDependencies {
  readonly trusted_bytes: unknown;
  readonly clock: { readonly now_epoch_ms: () => unknown };
  readonly cancellation: { readonly is_cancelled: () => unknown };
  readonly credential_store: P0BGoogleCredentialStore;
  readonly control: {
    readonly read_state: (request: unknown) => Promise<unknown>;
    readonly read_checkpoint: (request: unknown) => Promise<unknown>;
    readonly issue_lease: (request: unknown) => Promise<unknown>;
    readonly release_lease: (request: unknown) => Promise<unknown>;
  };
  readonly provider_process: {
    readonly embedWithCredential: (credential: any, request: unknown) => Promise<unknown>;
  };
  readonly ports: {
    readonly read_batch: (request: unknown) => Promise<unknown>;
    readonly commit: (request: unknown) => Promise<unknown>;
  };
  readonly reconciler: (input: unknown) => Promise<P0BGoogleReconcilerReceipt>;
}

export async function runP0BGoogleOfflineRunner(
  value: unknown,
  dependencies: P0BGoogleOfflineRunnerDependencies,
) {
  if (P0B_GOOGLE_RUNTIME_EXECUTION_STATE === 'UNFINALIZED_NOEXEC') {
    throw new Error('P0B_GOOGLE_RUNTIME_UNFINALIZED_NOEXEC');
  }
  const request = parseRequest(value);
  assertExactBytes(request, dependencies.trusted_bytes);
  bounded(request, dependencies);

  const state = exact(await dependencies.control.read_state(Object.freeze({
    schema_version: 1, deadline_epoch_ms: request.limits.deadline_epoch_ms,
  })), ['state', 'fingerprint']);
  if (state.state !== 'RECONCILING' || state.fingerprint !== request.state_fingerprint) {
    throw new Error('P0B_LIFECYCLE_MISMATCH');
  }
  const checkpoint = await dependencies.control.read_checkpoint(Object.freeze({
    schema_version: 1,
    expected_state_fingerprint: request.state_fingerprint,
    deadline_epoch_ms: request.limits.deadline_epoch_ms,
  }));
  if (!plain(checkpoint) || checkpoint.revision !== request.checkpoint_revision) {
    throw new Error('P0B_CHECKPOINT_MISMATCH');
  }
  bounded(request, dependencies);
  const lease = exact(await dependencies.control.issue_lease(Object.freeze({
    schema_version: 1,
    expected_state_fingerprint: request.state_fingerprint,
    expected_checkpoint_revision: request.checkpoint_revision,
    lease_id: request.lease_id,
    nonce: request.nonce,
    duration_ms: Math.min(300_000, request.limits.deadline_epoch_ms - now(dependencies)),
    deadline_epoch_ms: request.limits.deadline_epoch_ms,
  })), ['authority']);
  const authority = exact(lease.authority, ['lease_id', 'fence_token']);
  if (authority.lease_id !== request.lease_id
    || typeof authority.fence_token !== 'string' || !FENCE_RE.test(authority.fence_token)) {
    throw new Error('P0B_LEASE_MISMATCH');
  }

  let reconcilerReceipt: P0BGoogleReconcilerReceipt;
  try {
    reconcilerReceipt = await withP0BGoogleCredential(
      dependencies.credential_store,
      async credential => {
        bounded(request, dependencies);
        return await dependencies.reconciler(Object.freeze({
          initial_checkpoint: checkpoint,
          limits: request.limits,
          authority: Object.freeze({ ...authority }),
          clock: dependencies.clock,
          reader: Object.freeze({ read_batch: dependencies.ports.read_batch }),
          provider: Object.freeze({
            embed: async (providerRequest: unknown) => dependencies.provider_process.embedWithCredential(credential, providerRequest),
          }),
          committer: Object.freeze({ commit: dependencies.ports.commit }),
          cancellation: dependencies.cancellation,
        }));
      },
    );
  } finally {
    // The reconciler advances the checkpoint while holding this exclusive lease.
    // Re-read the current revision before release; using the launch revision would
    // deterministically leak every lease after the first successful commit.
    const currentCheckpoint = await dependencies.control.read_checkpoint(Object.freeze({
      schema_version: 1,
      expected_state_fingerprint: request.state_fingerprint,
      authority: Object.freeze({ ...authority }),
      deadline_epoch_ms: request.limits.deadline_epoch_ms,
    }));
    if (!plain(currentCheckpoint)
      || typeof currentCheckpoint.revision !== 'string'
      || !SHA256_RE.test(currentCheckpoint.revision)) {
      throw new Error('P0B_CHECKPOINT_MISMATCH');
    }
    await dependencies.control.release_lease(Object.freeze({
      schema_version: 1,
      expected_state_fingerprint: request.state_fingerprint,
      expected_checkpoint_revision: currentCheckpoint.revision,
      authority: Object.freeze({ ...authority }),
      deadline_epoch_ms: request.limits.deadline_epoch_ms,
    }));
  }

  return Object.freeze({
    schema_version: 1,
    outcome: reconcilerReceipt.outcome,
    rows_read: reconcilerReceipt.rows_read,
    rows_eligible: reconcilerReceipt.rows_eligible,
    rows_updated: reconcilerReceipt.rows_updated,
    row_conflicts: reconcilerReceipt.row_conflicts,
    provider_batches: reconcilerReceipt.provider_batches,
    estimated_tokens: reconcilerReceipt.estimated_tokens,
    estimated_cost_usd: reconcilerReceipt.estimated_cost_usd,
    completed_passes: reconcilerReceipt.completed_passes,
    source_fingerprint_digest: reconcilerReceipt.source_fingerprint_digest,
    vector_digest: reconcilerReceipt.vector_digest,
    checkpoint_digest: reconcilerReceipt.checkpoint_digest,
    candidate_commit_sha256_binding: request.candidate_commit_sha,
    package_root_sha256: request.package_root_sha256,
  });
}
