import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { LATEST_VERSION } from '../src/core/migrate.ts';

describe('ai review abstain migration', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  test('upgrades the previous approve/reject constraint to admit abstain', async () => {
    await engine.executeRaw(`ALTER TABLE ai_review_votes DROP CONSTRAINT IF EXISTS ai_review_votes_decision_check`);
    await engine.executeRaw(`ALTER TABLE ai_review_votes ADD CONSTRAINT ai_review_votes_decision_check CHECK (decision IN ('approve','reject'))`);
    await engine.executeRaw(`UPDATE config SET value='136' WHERE key='version'`);

    await engine.initSchema();

    const version = await engine.executeRaw<{ value: string }>(`SELECT value FROM config WHERE key='version'`);
    expect(Number(version[0]!.value)).toBe(LATEST_VERSION);

    await engine.executeRaw(`INSERT INTO sources (id,name,config) VALUES ('migration-review','Migration review','{}'::jsonb)`);
    const rounds = await engine.executeRaw<{ id: number }>(
      `INSERT INTO ai_review_rounds
         (target_type,target_id,source_id,proposal_snapshot_hash,policy_kind,status,opened_by,due_at)
       VALUES ('take_proposal',1,'migration-review','snapshot','shared','open','test',now() + interval '1 day')
       RETURNING id`,
    );
    const assignments = await engine.executeRaw<{ id: number }>(
      `INSERT INTO ai_review_assignments (round_id,reviewer_email)
       VALUES ($1,'abstain@example.test'),
              ($1,'unknown@example.test'),
              ($1,'reject@example.test')
       RETURNING id`, [rounds[0]!.id],
    );
    await expect(engine.executeRaw(
      `INSERT INTO ai_review_votes
         (round_id,assignment_id,decision,voter_kind,actor_email,proposal_snapshot_hash,idempotency_key)
       VALUES ($1,$2,'abstain','portal_user','abstain@example.test','snapshot','migration-abstain')`,
      [rounds[0]!.id, assignments[0]!.id],
    )).resolves.toBeDefined();

    await expect(engine.executeRaw(
      `INSERT INTO ai_review_votes
         (round_id,assignment_id,decision,voter_kind,actor_email,proposal_snapshot_hash,idempotency_key)
       VALUES ($1,$2,'unknown','portal_user','unknown@example.test','snapshot','migration-unknown')`,
      [rounds[0]!.id, assignments[1]!.id],
    )).rejects.toThrow();

    await expect(engine.executeRaw(
      `INSERT INTO ai_review_votes
         (round_id,assignment_id,decision,voter_kind,actor_email,proposal_snapshot_hash,idempotency_key)
       VALUES ($1,$2,'reject','portal_user','reject@example.test','snapshot','migration-reject-no-reason')`,
      [rounds[0]!.id, assignments[2]!.id],
    )).rejects.toThrow();
  });
});
