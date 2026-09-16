import type { BrainEngine } from '../../../src/core/engine.ts';

/** Test-only delegate: stop after real Git, before root observation/cleanup. */
export function installDirtyRootBoundary(engine: Pick<BrainEngine, 'executeRaw'>, stop: () => Promise<never>): () => void {
  const execute = engine.executeRaw;
  let captures = 0;
  engine.executeRaw = async function <T = Record<string, unknown>>(sql: string, params?: any[]): Promise<T[]> {
    const result = await execute.call(this, sql, params) as T[];
    // Root transition's cohort-aware read includes source_id/slug. First read
    // precedes invalidation; second follows Git and precedes finish/observation.
    if (sql === 'SELECT * FROM public.page_file_bindings'
      && ++captures === 2) await stop();
    return result;
  };
  return () => { engine.executeRaw = execute; };
}
