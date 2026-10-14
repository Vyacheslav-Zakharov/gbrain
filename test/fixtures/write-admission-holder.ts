import type { BrainEngine } from '../../src/core/engine.ts';
import { withSourceWrites, withExclusiveSourceWrites } from '../../src/core/write-admission.ts';
const [path, mode] = process.argv.slice(2);
const engine = { executeRaw: async () => [{ id: 'shared', local_path: path }] } as unknown as BrainEngine;
await (mode === 'shared' ? withSourceWrites : withExclusiveSourceWrites)(engine, ['shared'], async () => {
  console.log('ADMITTED');
  for await (const _ of Bun.stdin.stream()) break;
}, { durable: mode === 'durable' });
