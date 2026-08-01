/**
 * Wiring contract for the multi-reviewer HTTP surface.
 *
 * Behavioral coverage (ACL, unanimity, idempotency, escalation, finalization)
 * lives in `test/ai-review-rounds.test.ts` against a real PGLite engine. This
 * file pins the properties that only exist at the route layer and that a
 * behavioral test cannot see: that identity comes from the session, that the
 * browser cannot supply an actor or reviewer list, and that error codes map to
 * the documented statuses.
 */
import { describe, expect, test } from 'bun:test';
import { REJECT_REASONS, rejectReasonsFor } from '../src/core/ai-review-reasons.ts';
import { REVIEW_REJECT_REASONS, reasonsForTarget } from '../portal/src/review/reasons.ts';
import { isReviewRoute, REVIEW_ROUTE } from '../portal/src/review-route.ts';

const serveSource = await Bun.file(new URL('../src/commands/serve-http.ts', import.meta.url)).text();
const portalApiSource = await Bun.file(new URL('../portal/src/api.ts', import.meta.url)).text();
const adminApiSource = await Bun.file(new URL('../admin/src/api.ts', import.meta.url)).text();
const roundsSource = await Bun.file(new URL('../src/core/ai-review-rounds.ts', import.meta.url)).text();

describe('portal reviewer routes', () => {
  test('the reviewer deck is served from the Portal SPA behind the page guard', () => {
    expect(serveSource).toContain("app.get(['/portal/review', '/portal/review/'], requirePortalPage, sendPortalIndex)");
    expect(isReviewRoute('/portal/review')).toBe(true);
    expect(isReviewRoute('/portal/review/')).toBe(true);
    expect(isReviewRoute('/portal')).toBe(false);
    expect(REVIEW_ROUTE).toBe('/portal/review');
  });

  test('every reviewer endpoint requires a Portal session', () => {
    for (const route of [
      "app.get('/portal/api/review/summary'",
      "app.get('/portal/api/review/deck'",
      "app.get('/portal/api/review/items/:assignmentId'",
      "app.post('/portal/api/review/items/:assignmentId/vote'",
    ]) {
      expect(serveSource).toContain(route);
    }
    const voteHandler = serveSource.slice(serveSource.indexOf("app.post('/portal/api/review/items/:assignmentId/vote'"));
    expect(voteHandler.slice(0, 900)).toContain('const userEmail = requirePortalUser(req, res)');
  });

  test('identity and ACL are derived server-side, never taken from the request', () => {
    expect(serveSource).toContain('const reviewerScopeFor = async (email: string): Promise<ReviewerScope> => ({');
    expect(serveSource).toContain('allowedWriteSources: await getWriteSourceIdsForUser(');
    // The vote body carries only the decision payload — no actor, no reviewer
    // list, no source id. Adding one of those here is the leak this pins.
    const voteBody = serveSource.slice(
      serveSource.indexOf('const result = await castReviewerVote(engine, scope, {'),
      serveSource.indexOf('const result = await castReviewerVote(engine, scope, {') + 600,
    );
    expect(voteBody).toContain('decision: req.body?.decision');
    expect(voteBody).not.toContain('req.body?.actor');
    expect(voteBody).not.toContain('req.body?.reviewer');
    expect(voteBody).not.toContain('req.body?.source_id');
    expect(voteBody).not.toContain('req.body?.allowed');
  });

  test('the vote endpoint is same-origin gated and body-capped', () => {
    expect(serveSource).toContain("app.post('/portal/api/review/items/:assignmentId/vote', requirePortalSameOrigin, express.json({ limit: '32kb' })");
    expect(serveSource).toContain("res.status(403).json({ error: 'cross_site_review_mutation_rejected' })");
  });

  test('the vote response stays blind: no other reviewer, no tally', () => {
    const response = serveSource.slice(
      serveSource.indexOf('// Blind until closure'),
      serveSource.indexOf('// Blind until closure') + 700,
    );
    expect(response).toContain('round_status: result.round.status');
    expect(response).not.toContain('result.aggregate.approvals');
    expect(response).not.toContain('matrix');
    expect(response).not.toContain('voters');
  });

  test('reviewer-facing payloads never carry the named vote matrix', () => {
    // getReviewerItem / listReviewerDeck build their own shapes; only the
    // Admin detail selects reviewer_email alongside a decision.
    const adminDetail = roundsSource.indexOf('export async function getReviewRoundDetail');
    const deck = roundsSource.indexOf('export async function listReviewerDeck');
    expect(roundsSource.indexOf('a.reviewer_email, a.id AS assignment_id')).toBeGreaterThan(adminDetail);
    const deckBody = roundsSource.slice(deck, roundsSource.indexOf('export interface ReviewerItemDetail'));
    expect(deckBody).not.toContain('v.decision');
    expect(deckBody).not.toContain('reviewer_email,');
  });

  test('error codes map to the documented HTTP statuses', () => {
    for (const [code, status] of [
      ['foreign_assignment', '403'],
      ['source_access_revoked', '403'],
      ['stale_proposal', '409'],
      ['round_closed', '409'],
      ['concurrent_finalization', '409'],
      ['reason_code_required', '422'],
      ['override_reason_required', '422'],
      ['not_found', '404'],
    ] as const) {
      expect(serveSource).toContain(`${code}: ${status}`);
    }
    expect(serveSource).toContain("res.status(reviewErrorStatus[error.code] ?? 409)");
  });

  test('the client sends an idempotency key with every vote attempt', () => {
    expect(portalApiSource).toContain("'Idempotency-Key': idempotencyKey");
    expect(serveSource).toContain("idempotencyKey: req.get('idempotency-key')");
  });
});

describe('admin round routes', () => {
  test('round management is admin-gated and mutations are same-origin gated', () => {
    expect(serveSource).toContain("app.get('/admin/api/ai-review/rounds', requireAdmin,");
    expect(serveSource).toContain("app.get('/admin/api/ai-review/rounds/:id', requireAdmin,");
    expect(serveSource).toContain("app.post('/admin/api/ai-review/rounds/:id/finalize', requireAdmin, requireAdminSameOrigin,");
    expect(serveSource).toContain("app.post('/admin/api/ai-review/rounds', requireAdmin, requireAdminSameOrigin,");
  });

  test('the reviewer list for a new round comes from the permissions file, not the request', () => {
    const create = serveSource.slice(
      serveSource.indexOf("app.post('/admin/api/ai-review/rounds', requireAdmin"),
      serveSource.indexOf("app.get('/admin/api/ai-review/rounds', requireAdmin"),
    );
    expect(create).toContain('permissions: loadUserPermissionsMap()');
    expect(create).toContain('actor: adminActor(req)');
    expect(create).not.toContain('req.body?.reviewers');
    expect(create).not.toContain('req.body?.actor');
  });

  test('admin finalize always forwards a reason and a server-derived actor', () => {
    const finalize = serveSource.slice(serveSource.indexOf("app.post('/admin/api/ai-review/rounds/:id/finalize'"));
    expect(finalize.slice(0, 700)).toContain('actor: adminActor(req)');
    expect(finalize.slice(0, 700)).toContain('reason: req.body?.reason');
    expect(adminApiSource).toContain("reviewRoundFinalize: (id: number, action: 'accepted' | 'rejected', reason: string)");
  });

  test('legacy direct accept and reject routes cannot bypass a managed review round', () => {
    expect(serveSource).toContain("await assertDirectAdminReviewAllowed('take_proposal', Number(req.params.id));");
    expect(serveSource).toContain("await assertDirectAdminReviewAllowed('concept_proposal', Number(req.params.id));");
    expect((serveSource.match(/assertDirectAdminReviewAllowed\('take_proposal'/g) ?? [])).toHaveLength(2);
    expect((serveSource.match(/assertDirectAdminReviewAllowed\('concept_proposal'/g) ?? [])).toHaveLength(2);
    expect(serveSource).toContain("'managed_by_review_round'");
  });
});

describe('reject reason taxonomy parity', () => {
  test('the Portal mirror matches the server taxonomy exactly', () => {
    expect(REVIEW_REJECT_REASONS.map(r => r.code)).toEqual(REJECT_REASONS.map(r => r.code));
    for (const server of REJECT_REASONS) {
      const client = REVIEW_REJECT_REASONS.find(r => r.code === server.code);
      expect(client).toBeDefined();
      expect(client!.label).toBe(server.label);
      expect(client!.commentRequired).toBe(server.commentRequired);
      expect(client!.scope).toBe(server.scope);
    }
  });

  test('per-deck filtering matches on both sides', () => {
    for (const target of ['take_proposal', 'concept_proposal'] as const) {
      expect(reasonsForTarget(target).map(r => r.code)).toEqual(rejectReasonsFor(target).map(r => r.code));
    }
  });
});

describe('session capability', () => {
  test('canReview is derived from the configured permission map, not the client', () => {
    const handler = serveSource.slice(
      serveSource.indexOf("app.get('/portal/api/session'"),
      serveSource.indexOf('// Portal reviewer API (multi-reviewer AI Review)'),
    );
    expect(handler).toContain('const configured = Object.keys(loadUserPermissionsMap())');
    expect(handler).toContain('canReview: configured && writeSources.length > 0');
    expect(handler).toContain('readOnly: true');
  });

  test('review ACL revocation is strict and never uses the implicit onboarding grant', () => {
    const helper = serveSource.slice(
      serveSource.indexOf('const getWriteSourceIdsForUser'),
      serveSource.indexOf('const managedAreaById'),
    );
    expect(helper).toContain('entry.active === false');
    expect(helper).toContain('entry.disabled === true');
    expect(helper).toContain('return []');
    expect(helper).not.toContain('getUserPermissions(email)');
  });
});
