import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canonicalizeP0BAuthorization,
  canonicalizeP0BPackageDescriptor,
  hashP0BPackageDescriptor,
  launchP0BAuthorityAction,
  P0B_AUTHORITY_EXECUTION_STATE,
  type P0BAuthorization,
  type P0BPackageDescriptor,
} from '../src/core/p0b-authority-launcher.ts';

const roots: string[] = [];
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const nonce = 'nonce-0123456789abcdef0123456789abcdef';
const action = 'P0B_GOOGLE_SCHEMA_FORWARD';
const packageRoot = sha('reviewed-package');

const descriptor: P0BPackageDescriptor = Object.freeze({
  schema_version: 1,
  artifact_kind: 'P0B_DURABLE_AUTHORITY_LAUNCHER_OFFLINE_SUCCESSOR',
  base_commit_sha: '4530b60747c6bf6a5acf3dc65ffcd6357917da8e',
  execution_state: 'OFFLINE_BUILTIN_INERT_ONLY_NOEXEC',
  production_mutation_authorized: false,
  package_root_definition: 'reviewed logical records; descriptor and manifest excluded',
  artifacts: Object.freeze([
    Object.freeze({ logical_name: 'SOURCE', path: 'src/core/p0b-authority-launcher.ts', sha256: sha('source'), bytes: 123 }),
  ]),
  security_properties: Object.freeze([
    'direct effective uid and gid enforcement',
    'closed built-in inert child',
    'exclusive durable claim and receipt reservation',
  ]),
  blockers: Object.freeze([
    'openat2 trusted-parent acquisition with RESOLVE_BENEATH and RESOLVE_NO_SYMLINKS is not implemented',
  ]),
  provenance: Object.freeze({
    catalog_artifact_path: 'ops/p0b-google-authority-launcher/expected-catalog-definitions.inert.json',
    basis: 'UNVERIFIED_TRANSCRIPTION',
    referenced_source_path: 'ops/p0b-google-schema/forward.sql.NOEXEC',
  }),
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'p0b-authority-'));
  roots.push(root);
  await chmod(root, 0o700);
  const stat = await lstat(root);
  expect(typeof process.geteuid).toBe('function');
  expect(typeof process.getegid).toBe('function');
  const actor = { uid: process.geteuid!(), gid: process.getegid!(), name: 'p0b-offline-reviewer' } as const;
  expect(stat.uid).toBe(actor.uid);
  expect(stat.gid).toBe(actor.gid);
  const authorization: P0BAuthorization = {
    schema_version: 1,
    action,
    actor,
    package_root_sha256: packageRoot,
    package_descriptor_sha256: hashP0BPackageDescriptor(descriptor),
    nonce,
    issued_at_epoch_ms: 1_000,
    not_before_epoch_ms: 1_000,
    expires_at_epoch_ms: 2_000,
  };
  const envelope = {
    schema_version: 1,
    authorization,
    signature: { algorithm: 'ed25519', key_id: 'offline-review-key-01', signature_hex: 'ab'.repeat(64) },
  };
  await writeFile(join(root, 'authorization.json'), JSON.stringify(envelope), { mode: 0o600 });
  await chmod(join(root, 'authorization.json'), 0o600);
  return { root, stat, actor, authorization, envelope };
}

function deps(f: Awaited<ReturnType<typeof fixture>>, overrides: Record<string, unknown> = {}) {
  return {
    clock: { now_epoch_ms: () => 1_500 },
    package_verifier: { verify_root_sha256: async () => packageRoot },
    signature_verifier: {
      verify: async (input: any) => {
        expect(input.algorithm).toBe('ed25519');
        expect(input.key_id).toBe('offline-review-key-01');
        expect(input.message.equals(canonicalizeP0BAuthorization(f.authorization))).toBe(true);
        return true;
      },
    },
    ...overrides,
  } as any;
}

function request(f: Awaited<ReturnType<typeof fixture>>, overrides: Record<string, unknown> = {}) {
  return {
    authority_directory: f.root,
    authorization_file: 'authorization.json',
    expected_action: action,
    expected_package_root_sha256: packageRoot,
    expected_package_descriptor: descriptor,
    expected_actor: f.actor,
    policy: {
      owner_uid: f.stat.uid,
      owner_gid: f.stat.gid,
      max_authorization_bytes: 16_384,
      max_validity_ms: 10_000,
      max_future_skew_ms: 0,
    },
    ...overrides,
  } as any;
}

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

describe('P0-B durable offline authority launcher successor', () => {
  test('uses a closed built-in inert child and publishes a terminal receipt', async () => {
    const f = await fixture();
    const hostileChild = {
      get execution_state() { throw new Error('hostile child state was inspected'); },
      get run() { throw new Error('hostile child was invoked'); },
    };
    const result = await launchP0BAuthorityAction(request(f), deps(f, { child: hostileChild }));
    expect(P0B_AUTHORITY_EXECUTION_STATE).toBe('OFFLINE_BUILTIN_INERT_ONLY_NOEXEC');
    expect(result.outcome).toBe('SUCCESS');
    expect(result.code).toBe('INERT_NOEXEC');
    const claim = JSON.parse(await readFile(join(f.root, `${nonce}.claim.json`), 'utf8'));
    const receipt = JSON.parse(await readFile(join(f.root, `${nonce}.receipt.json`), 'utf8'));
    expect(claim.status).toBe('CLAIMED');
    expect(receipt).toMatchObject({ outcome: 'SUCCESS', code: 'INERT_NOEXEC', nonce });
    expect((await lstat(join(f.root, `${nonce}.claim.json`))).mode & 0o077).toBe(0);
    expect((await lstat(join(f.root, `${nonce}.receipt.json`))).mode & 0o077).toBe(0);
  });

  test('caller identity spoofing is absent and cannot override effective OS identity', async () => {
    const f = await fixture();
    const spoof = {
      uid: () => { throw new Error('identity callback must not run'); },
      gid: () => { throw new Error('identity callback must not run'); },
    };
    await expect(launchP0BAuthorityAction(request(f), deps(f, { identity: spoof }))).resolves.toMatchObject({ code: 'INERT_NOEXEC' });

    const wrongActor = { ...f.actor, uid: f.actor.uid + 1 };
    await expect(launchP0BAuthorityAction(request(await fixture(), { expected_actor: wrongActor }), deps(f))).rejects.toThrow('P0B_ACTOR_MISMATCH');
  });

  test('rechecks time after asynchronous verifiers and uses the final clock', async () => {
    const f = await fixture();
    const readings = [1_500, 2_000];
    await expect(launchP0BAuthorityAction(request(f), deps(f, {
      clock: { now_epoch_ms: () => readings.shift() ?? 2_000 },
      signature_verifier: { verify: async () => true },
      package_verifier: { verify_root_sha256: async () => packageRoot },
    }))).rejects.toThrow('P0B_AUTHORIZATION_EXPIRED');
    await expect(lstat(join(f.root, `${nonce}.claim.json`))).rejects.toThrow();
  });

  test('uses final verifier-adjacent time for the durable claim', async () => {
    const f = await fixture();
    const readings = [1_500, 1_750, 1_800];
    await launchP0BAuthorityAction(request(f), deps(f, {
      clock: { now_epoch_ms: () => readings.shift() ?? 1_800 },
      signature_verifier: { verify: async () => true },
    }));
    const claim = JSON.parse(await readFile(join(f.root, `${nonce}.claim.json`), 'utf8'));
    expect(claim.claimed_at_epoch_ms).toBe(1_750);
  });

  test('a prior receipt blocks before the closed child and is never overwritten', async () => {
    const f = await fixture();
    const prior = '{"attacker":"prior"}\n';
    await writeFile(join(f.root, `${nonce}.receipt.json`), prior, { mode: 0o600 });
    await expect(launchP0BAuthorityAction(request(f), deps(f))).rejects.toThrow('P0B_RECEIPT_ALREADY_EXISTS');
    expect(await readFile(join(f.root, `${nonce}.receipt.json`), 'utf8')).toBe(prior);
    expect(JSON.parse(await readFile(join(f.root, `${nonce}.claim.json`), 'utf8')).status).toBe('CLAIMED');
  });

  test('replay never releases a claimed nonce', async () => {
    const f = await fixture();
    await launchP0BAuthorityAction(request(f), deps(f));
    await expect(launchP0BAuthorityAction(request(f), deps(f))).rejects.toThrow('P0B_AUTHORIZATION_REPLAYED');
    expect(await lstat(join(f.root, `${nonce}.claim.json`))).toBeTruthy();
  });

  test('rejects expired and future authorization before claim', async () => {
    for (const [label, times] of [
      ['expired', { issued_at_epoch_ms: 500, not_before_epoch_ms: 500, expires_at_epoch_ms: 1_500 }],
      ['future', { issued_at_epoch_ms: 1_501, not_before_epoch_ms: 1_501, expires_at_epoch_ms: 2_000 }],
    ] as const) {
      const f = await fixture();
      f.envelope.authorization = { ...f.authorization, ...times } as any;
      await writeFile(join(f.root, 'authorization.json'), JSON.stringify(f.envelope), { mode: 0o600 });
      await expect(launchP0BAuthorityAction(request(f), deps(f))).rejects.toThrow(
        label === 'expired' ? 'P0B_AUTHORIZATION_EXPIRED' : 'P0B_AUTHORIZATION_FUTURE',
      );
    }
  });

  test('rejects symlink authorization, mutable directory, and mode 0700 authorization', async () => {
    const symlinkFixture = await fixture();
    await writeFile(join(symlinkFixture.root, 'real.json'), JSON.stringify(symlinkFixture.envelope), { mode: 0o600 });
    await rm(join(symlinkFixture.root, 'authorization.json'));
    await symlink('real.json', join(symlinkFixture.root, 'authorization.json'));
    await expect(launchP0BAuthorityAction(request(symlinkFixture), deps(symlinkFixture))).rejects.toThrow('P0B_AUTHORIZATION_FILE_REJECTED');

    const fileFixture = await fixture();
    await chmod(join(fileFixture.root, 'authorization.json'), 0o700);
    await expect(launchP0BAuthorityAction(request(fileFixture), deps(fileFixture))).rejects.toThrow('P0B_AUTHORIZATION_FILE_REJECTED');

    const dirFixture = await fixture();
    await chmod(dirFixture.root, 0o777);
    await expect(launchP0BAuthorityAction(request(dirFixture), deps(dirFixture))).rejects.toThrow('P0B_AUTHORITY_DIRECTORY_REJECTED');
  });

  test('binds canonical descriptor security metadata and provenance into authorization', async () => {
    const canonical = canonicalizeP0BPackageDescriptor(descriptor);
    expect(sha(canonical.toString('utf8'))).toBe(hashP0BPackageDescriptor(descriptor));
    expect(canonical.toString('utf8')).toContain('UNVERIFIED_TRANSCRIPTION');
    expect(canonical.toString('utf8')).toContain('closed built-in inert child');

    const f = await fixture();
    const changed = {
      ...descriptor,
      security_properties: [...descriptor.security_properties, 'attacker replacement metadata'],
    };
    await expect(launchP0BAuthorityAction(request(f, { expected_package_descriptor: changed }), deps(f)))
      .rejects.toThrow('P0B_AUTHORIZATION_BINDING_MISMATCH');
  });

  test('normalizes raw filesystem and verifier errors without leaking details', async () => {
    const missing = await fixture();
    const missingPath = join(missing.root, 'secret-host-path');
    await expect(launchP0BAuthorityAction(request(missing, { authority_directory: missingPath }), deps(missing)))
      .rejects.toThrow('P0B_FILESYSTEM_METADATA_FAILED');
    try {
      await launchP0BAuthorityAction(request(missing, { authority_directory: missingPath }), deps(missing));
    } catch (error) {
      expect(String(error)).not.toContain(missingPath);
    }

    const signature = await fixture();
    await expect(launchP0BAuthorityAction(request(signature), deps(signature, {
      signature_verifier: { verify: async () => { throw new Error('/private/key/path hostile detail'); } },
    }))).rejects.toThrow('P0B_SIGNATURE_VERIFIER_FAILED');

    const pkg = await fixture();
    await expect(launchP0BAuthorityAction(request(pkg), deps(pkg, {
      signature_verifier: { verify: async () => true },
      package_verifier: { verify_root_sha256: async () => { throw new Error('dependency secret'); } },
    }))).rejects.toThrow('P0B_PACKAGE_VERIFIER_FAILED');
  });

  test('pins opened directory identity and preserves the openat2 blocker', async () => {
    const source = await readFile(join(import.meta.dir, '..', 'src/core/p0b-authority-launcher.ts'), 'utf8');
    expect(source).toMatch(/openedStat\.dev\s*!==\s*suppliedStat\.dev/);
    expect(source).toMatch(/openedStat\.ino\s*!==\s*suppliedStat\.ino/);
    const manifest = JSON.parse(await readFile(join(import.meta.dir, '..', 'ops/p0b-google-authority-launcher/manifest.json'), 'utf8'));
    expect(manifest.blockers.join(' ')).toContain('openat2');
  });

  test('package stays inert with no process launcher, privilege changer, or database client', async () => {
    const source = await readFile(join(import.meta.dir, '..', 'src/core/p0b-authority-launcher.ts'), 'utf8');
    expect(source).toContain('process.geteuid()');
    expect(source).toContain('process.getegid()');
    expect(source).not.toContain('node:child_process');
    expect(source).not.toMatch(/\b(psql|sudo|setuid|spawn|execFile|execSync)\b/);
    expect(source).not.toContain('dependencies.child');
    const manifest = JSON.parse(await readFile(join(import.meta.dir, '..', 'ops/p0b-google-authority-launcher/manifest.json'), 'utf8'));
    expect(manifest.execution_state).toBe('OFFLINE_BUILTIN_INERT_ONLY_NOEXEC');
    expect(manifest.production_mutation_authorized).toBe(false);
    expect(manifest.signed_descriptor.security_properties).toContain('closed built-in inert child');
    expect(manifest.signed_descriptor.provenance.basis).toBe('UNVERIFIED_TRANSCRIPTION');
  });
});
