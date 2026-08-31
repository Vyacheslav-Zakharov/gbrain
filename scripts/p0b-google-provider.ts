#!/usr/bin/env bun
import { runP0BGoogleProviderExecutable } from '../src/core/p0b-google-provider-process.ts';

// This concrete entrypoint intentionally accepts no argv or environment configuration.
// Its first runtime action is the reviewed UNFINALIZED_NOEXEC fence.
await runP0BGoogleProviderExecutable();
