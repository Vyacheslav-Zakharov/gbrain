import type { BrainEngine } from '../src/core/engine.ts';

/**
 * This package is intentionally not executable through a normal GBrain engine.
 * Two prerequisites are absent from the current launcher contract:
 *
 * 1. an exact, independently verified receipt from the root/postgres-only role
 *    bootstrap candidate; and
 * 2. a durable authorization nonce claim committed before child SQL starts,
 *    followed by terminal success/failure recording in a later transaction.
 *
 * A transactionRaw callback cannot provide that protocol: rollback of the child
 * transaction would also roll back a nonce inserted in that transaction.  The
 * future launcher must expose a root-reviewed bootstrap receipt input and a
 * dedicated claim/finalize store whose claim commit precedes this runner.
 */
export const P0B_SCHEMA_EXECUTION_STATE = 'BLOCKED_PREREQUISITES_NOEXEC' as const;

export const P0B_SCHEMA_BLOCKERS = Object.freeze({
  role_bootstrap_receipt: 'REQUIRED_NOT_PRESENT',
  durable_nonce_launcher: 'REQUIRED_NOT_IMPLEMENTED',
  required_launcher_contract:
    'claim authorization nonce in a separate committed authority transaction; verify exact root/postgres role-bootstrap receipt; execute child SQL as session_user=gbrain_p0b_migrator after SET ROLE gbrain_p0b_owner; record terminal success or failure without releasing the nonce',
} as const);

export interface RunP0BGoogleSchemaInput {
  readonly engine: BrainEngine;
  readonly action: 'FORWARD' | 'VERIFY' | 'INVERSE';
  readonly manifest: unknown;
  readonly role_bootstrap_receipt: unknown;
  readonly authorization: unknown;
}

export async function runP0BGoogleSchema(
  _input: RunP0BGoogleSchemaInput,
): Promise<never> {
  throw new Error('P0B_SCHEMA_BLOCKED_DURABLE_NONCE_LAUNCHER_REQUIRED');
}
