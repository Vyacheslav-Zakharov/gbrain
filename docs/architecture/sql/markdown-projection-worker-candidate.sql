-- DEVELOPMENT ONLY, unregistered delta after markdown-projection-candidate.sql.
-- Owner-only root setup while disabled. No grants or automatic enrollment.
BEGIN;
ALTER TABLE public.markdown_projection_policy ADD COLUMN root_path text;
ALTER TABLE public.markdown_projection_obligations DROP CONSTRAINT markdown_projection_obligations_status_check;
ALTER TABLE public.markdown_projection_obligations ADD CONSTRAINT markdown_projection_obligations_status_check CHECK(status IN ('pending','blocked_policy','materialized'));
ALTER TABLE public.markdown_projection_obligations
 ADD COLUMN current_path text,
 ADD COLUMN current_hash text,
 ADD COLUMN materialized_generation bigint;
CREATE FUNCTION public.markdown_projection_root_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.root_path IS DISTINCT FROM OLD.root_path AND (OLD.enabled OR NEW.enabled) THEN
  RAISE EXCEPTION 'disable before changing projection root';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER mp_root_guard BEFORE UPDATE ON public.markdown_projection_policy
FOR EACH ROW EXECUTE FUNCTION public.markdown_projection_root_guard();
REVOKE ALL ON FUNCTION public.markdown_projection_root_guard() FROM PUBLIC;
-- Only this view is a current reference. Retained old pointer columns are not current.
CREATE VIEW public.markdown_projection_current AS
 SELECT o.source_id,o.incarnation,o.generation,o.current_path,o.current_hash,g.root_path
 FROM public.markdown_projection_obligations o JOIN public.markdown_projection_policy g USING(source_id)
 WHERE g.alive AND g.enabled AND o.status='materialized' AND o.operation='upsert'
 AND o.policy_generation=g.policy_generation AND o.materialized_generation=o.generation;
REVOKE ALL ON public.markdown_projection_current FROM PUBLIC;
-- Queue-independent containment ledger. Candidate only, never startup DDL.
-- No cascading FK to jobs, sources, policy, or obligations: deletion is not stop.
CREATE TABLE public.markdown_projection_attempts (
 source_id text NOT NULL,
 run_id uuid PRIMARY KEY,
 job_id bigint NOT NULL,
 host_id text NOT NULL,
 boot_id text NOT NULL,
 owner_pid integer NOT NULL CHECK(owner_pid>0),
 owner_start text NOT NULL,
 supervisor_pid integer CHECK(supervisor_pid>0),
 supervisor_start text,
 state text NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','running','reaped')),
 created_at timestamptz NOT NULL DEFAULT now(),
 released_at timestamptz,
 CHECK ((released_at IS NOT NULL) = (state='reaped')),
 CHECK ((supervisor_pid IS NULL) = (supervisor_start IS NULL))
);
CREATE UNIQUE INDEX markdown_projection_one_unreaped_source
 ON public.markdown_projection_attempts(source_id) WHERE released_at IS NULL;
REVOKE ALL ON public.markdown_projection_attempts FROM PUBLIC;
-- Owner-enrolled physical login/source authority; never writable by runtime.
CREATE TABLE public.markdown_projection_attempt_authority (
 login_name name NOT NULL, source_id text NOT NULL, PRIMARY KEY(login_name,source_id)
);
REVOKE ALL ON public.markdown_projection_attempt_authority FROM PUBLIC;
ALTER TABLE public.markdown_projection_attempt_authority ENABLE ROW LEVEL SECURITY;
CREATE POLICY mp_attempt_authority_self ON public.markdown_projection_attempt_authority
 FOR SELECT USING(login_name=session_user);
ALTER TABLE public.markdown_projection_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.markdown_projection_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY mp_attempt_source ON public.markdown_projection_attempts
 USING(EXISTS(SELECT 1 FROM public.markdown_projection_attempt_authority a WHERE a.login_name=session_user AND a.source_id=markdown_projection_attempts.source_id))
 WITH CHECK(EXISTS(SELECT 1 FROM public.markdown_projection_attempt_authority a WHERE a.login_name=session_user AND a.source_id=markdown_projection_attempts.source_id));
-- Explicit enrollment/grants remain owner-approved and external, not startup DDL.
-- For EACH reviewed ordinary login, grant only:
-- SELECT on attempts and attempt_authority;
-- INSERT(source_id,run_id,job_id,host_id,boot_id,owner_pid,owner_start) on attempts;
-- UPDATE(supervisor_pid,supervisor_start,state,released_at) on attempts.
-- Never DELETE/TRUNCATE, identity UPDATE, table-wide INSERT/UPDATE, role membership,
-- or authority-table writes. Direct DML login is trusted; RLS is not stop proof.
-- No operator reset routine, TTL, or automatic enrollment.
-- Finite scheduler diagnostics survive generic job deletion. Not stop authority.
CREATE TABLE public.markdown_projection_source_status (
 source_id text PRIMARY KEY,
 scheduler_seen_at timestamptz,
 worker_seen_at timestamptz,
 last_error text,
 CHECK(last_error IS NULL OR last_error IN ('projection_attempt_failed','projection_schedule_failed','projection_configuration_failed'))
);
REVOKE ALL ON public.markdown_projection_source_status FROM PUBLIC;
ALTER TABLE public.markdown_projection_source_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.markdown_projection_source_status FORCE ROW LEVEL SECURITY;
CREATE POLICY mp_status_source ON public.markdown_projection_source_status
 USING(EXISTS(SELECT 1 FROM public.markdown_projection_attempt_authority a WHERE a.login_name=session_user AND a.source_id=markdown_projection_source_status.source_id))
 WITH CHECK(EXISTS(SELECT 1 FROM public.markdown_projection_attempt_authority a WHERE a.login_name=session_user AND a.source_id=markdown_projection_source_status.source_id));
-- Separately reviewed login grants: SELECT, INSERT(source_id,scheduler_seen_at,
-- worker_seen_at,last_error), UPDATE(scheduler_seen_at,worker_seen_at,last_error).
COMMIT;
