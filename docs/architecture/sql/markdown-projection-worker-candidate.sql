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
COMMIT;
