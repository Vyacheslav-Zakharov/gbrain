export type ReviewTargetType = 'take_proposal' | 'concept_proposal';

export interface ReviewRejectReason {
  code: string;
  label: string;
  commentRequired: boolean;
  scope: 'both' | 'concept_proposal';
}

export interface ReviewDeckCard {
  assignment_id: number;
  round_id: number;
  target_type: ReviewTargetType;
  target_id: number;
  source_id: string;
  page_slug: string;
  page_title: string | null;
  headline: string;
  preview: string;
  evidence_count: number;
  proposal_snapshot_hash: string;
  due_at: string;
  proposed_at: string;
  policy_kind: 'personal' | 'shared';
  details_opened: boolean;
}

export interface ReviewItemDetail extends ReviewDeckCard {
  detail: string;
  provenance: {
    source_id: string;
    page_slug: string;
    page_title: string | null;
    proposed_at: string;
    proposal_run_id: string | null;
    model_id: string | null;
    supporting_sources: Array<{
      source_id: string;
      page_slug: string;
      claim: string | null;
    }>;
  };
}

export interface ReviewSummary {
  pending: number;
  escalated_visible: number;
  reasons: ReviewRejectReason[];
}

export interface ReviewVoteResponse {
  decision: 'approve' | 'reject';
  replayed: boolean;
  round_status: 'open' | 'escalated' | 'finalizing' | 'finalized' | 'cancelled';
  outcome: 'accepted' | 'rejected' | null;
  publication_pending: boolean;
}
