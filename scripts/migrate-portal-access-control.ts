#!/usr/bin/env bun
import { join } from 'node:path';
import { loadConfig, toEngineConfig } from '../src/core/config.ts';
import { connectWithRetry } from '../src/core/db.ts';
import { createEngine } from '../src/core/engine-factory.ts';
import {
  applyPortalAccessControlSnapshot,
  comparePortalAccessControlSnapshot,
  exportPortalAccessControlJson,
  loadPortalAccessControlJson,
} from '../src/core/portal-access-control-migration.ts';

interface Flags {
  mode: 'dry-run' | 'apply' | 'compare' | 'export';
  permissionsPath: string;
  requestsPath: string;
  exportPath?: string;
  actorEmail?: string;
}

function parseFlags(argv: string[]): Flags {
  const home = process.env.HOME || '/home/avers';
  let mode: Flags['mode'] | undefined;
  let exportPath: string | undefined;
  let permissionsPath = join(home, '.gbrain', 'user_permissions.json');
  let requestsPath = join(home, '.gbrain', 'access_requests.json');
  let actorEmail: string | undefined;
  const next = (index: number, flag: string): string => {
    const value = argv[index + 1];
    if (!value) throw new Error(`${flag} requires a value`);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]!;
    if (flag === '--dry-run' || flag === '--apply' || flag === '--compare') {
      if (mode) throw new Error('exactly_one_mode_required');
      mode = flag.slice(2) as Flags['mode'];
    } else if (flag === '--export-json') {
      if (mode) throw new Error('exactly_one_mode_required');
      mode = 'export';
      exportPath = next(i, flag);
      i += 1;
    } else if (flag === '--permissions') {
      permissionsPath = next(i, flag);
      i += 1;
    } else if (flag === '--requests') {
      requestsPath = next(i, flag);
      i += 1;
    } else if (flag === '--actor-email') {
      actorEmail = next(i, flag);
      i += 1;
    } else {
      throw new Error(`unknown_flag:${flag}`);
    }
  }
  if (!mode) throw new Error('exactly_one_mode_required');
  if (mode === 'apply' && !actorEmail) throw new Error('actor_email_required');
  return { mode, permissionsPath, requestsPath, exportPath, actorEmail };
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.mode === 'dry-run') {
    const snapshot = loadPortalAccessControlJson(flags);
    process.stdout.write(`${JSON.stringify({ mode: flags.mode, ...snapshot.summary })}\n`);
    return;
  }

  const config = loadConfig();
  if (!config) throw new Error('No brain configured. Run `gbrain init` first.');
  const engineConfig = toEngineConfig(config);
  const engine = await createEngine(engineConfig);
  await connectWithRetry(engine, engineConfig, { noRetry: false });
  try {
    if (flags.mode === 'export') {
      const path = flags.exportPath!;
      const result = await exportPortalAccessControlJson(engine, {
        permissionsPath: join(path, 'user_permissions.json'),
        requestsPath: join(path, 'access_requests.json'),
      });
      process.stdout.write(`${JSON.stringify({ mode: flags.mode, ...result })}\n`);
      return;
    }

    const snapshot = loadPortalAccessControlJson(flags);
    if (flags.mode === 'compare') {
      const result = await comparePortalAccessControlSnapshot(engine, snapshot);
      process.stdout.write(`${JSON.stringify({ mode: flags.mode, ...result })}\n`);
      process.exitCode = result.total === 0 ? 0 : 2;
      return;
    }
    const result = await applyPortalAccessControlSnapshot(engine, snapshot, flags.actorEmail!);
    process.stdout.write(`${JSON.stringify({ mode: flags.mode, ...result })}\n`);
  } finally {
    await engine.disconnect();
  }
}

if (import.meta.main) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
