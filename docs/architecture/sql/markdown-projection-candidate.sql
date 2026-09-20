-- DEVELOPMENT CANDIDATE ONLY. NOT registered in MIGRATIONS; PostgreSQL only.
-- SOURCE-LOCAL candidate; no SQL execution proof. Activation remains BLOCKED.
-- Permanent policy rows ARE source guards, not optional enrollment metadata.
-- TRUNCATE explicitly unsupported even while disabled; use source-scoped DELETE.
-- Apply by trusted schema owner in a transaction, with public CREATE revoked.
-- No GRANT to application/source writers, no page scan, no default enrollment.
-- Database is the brain boundary. Identity UUID distinguishes page-id reuse.
BEGIN;
-- Atomic source-only seeding/lifecycle installation; no historical page scan.
LOCK TABLE public.sources, public.pages, public.tags IN SHARE ROW EXCLUSIVE MODE;
CREATE TABLE public.markdown_projection_policy (
  source_id text PRIMARY KEY,
  source_incarnation uuid NOT NULL DEFAULT gen_random_uuid(),
  alive boolean NOT NULL DEFAULT true,
  enabled boolean NOT NULL DEFAULT false,
  policy_generation bigint NOT NULL,
  activation_watermark bigint NOT NULL
);
CREATE SEQUENCE public.markdown_projection_clock;
INSERT INTO public.markdown_projection_policy(source_id,policy_generation,activation_watermark)
SELECT id,0,0 FROM public.sources;
-- Trusted page-deletion context; transaction ID prevents stale context reuse.
-- Deferred cleanup bounds retention to this transaction, including cascade execution.
CREATE TABLE public.markdown_projection_deleting (
  xid bigint NOT NULL, page_id integer NOT NULL, incarnation uuid NOT NULL,
  PRIMARY KEY(xid,page_id)
);
REVOKE ALL ON public.markdown_projection_deleting FROM PUBLIC;
CREATE TABLE public.markdown_projection_identity (
  page_id integer PRIMARY KEY,
  incarnation uuid NOT NULL DEFAULT gen_random_uuid()
);
CREATE TABLE public.markdown_projection_obligations (
  source_id text NOT NULL,
  incarnation uuid NOT NULL,
  page_id integer NOT NULL,
  generation bigint NOT NULL,
  policy_generation bigint NOT NULL,
  operation text NOT NULL CHECK (operation IN ('upsert','tombstone')),
  desired_slug text NOT NULL,
  prior_slugs text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','blocked_policy')),
  first_pending_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  renderer_version text NOT NULL DEFAULT 'unconnected',
  PRIMARY KEY (source_id,incarnation)
  -- Deliberately NO foreign keys: source/page cascade purge cannot erase obligations.
);
REVOKE ALL ON public.markdown_projection_policy, public.markdown_projection_identity,
  public.markdown_projection_obligations, public.markdown_projection_clock FROM PUBLIC;

-- Key-only lock: consume returned tuple, never prefilter enabled or use SKIP LOCKED.
CREATE FUNCTION public.markdown_projection_admit(s text) RETURNS public.markdown_projection_policy
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE pol public.markdown_projection_policy;
BEGIN
  SELECT * INTO pol FROM public.markdown_projection_policy WHERE source_id=s FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'missing source guard; retry whole transaction' USING ERRCODE='40001'; END IF;
  RETURN pol;
END $$;
CREATE FUNCTION public.markdown_projection_lock_sources(ids text[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE s text;
BEGIN
  FOR s IN SELECT DISTINCT x COLLATE "C" FROM unnest(ids) AS u(x) WHERE x IS NOT NULL ORDER BY 1 LOOP
    PERFORM public.markdown_projection_admit(s);
  END LOOP;
END $$;
CREATE FUNCTION public.markdown_projection_publish_lock(s text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE pol public.markdown_projection_policy;
BEGIN
  SELECT * INTO pol FROM public.markdown_projection_policy WHERE source_id=s FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'missing source guard' USING ERRCODE='40001'; END IF;
  IF NOT pol.alive OR NOT pol.enabled THEN RAISE EXCEPTION 'source not enrolled'; END IF;
END $$;
CREATE FUNCTION public.markdown_projection_statement_lock() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'TRUNCATE cannot be source scoped; candidate requires DELETE' USING ERRCODE='0A000';
END $$;
CREATE TRIGGER mp_truncate BEFORE TRUNCATE ON public.pages
FOR EACH STATEMENT EXECUTE FUNCTION public.markdown_projection_statement_lock();
CREATE TRIGGER mp_truncate BEFORE TRUNCATE ON public.tags
FOR EACH STATEMENT EXECUTE FUNCTION public.markdown_projection_statement_lock();
CREATE TRIGGER mp_truncate BEFORE TRUNCATE ON public.sources
FOR EACH STATEMENT EXECUTE FUNCTION public.markdown_projection_statement_lock();
CREATE FUNCTION public.markdown_projection_set_policy(s text, enabled_value boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE g bigint; pol public.markdown_projection_policy;
BEGIN
  -- Lifecycle and enrollment use source -> guard order. No ordinary caller grant.
  PERFORM 1 FROM public.sources WHERE id=s FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown source'; END IF;
  SELECT * INTO pol FROM public.markdown_projection_policy WHERE source_id=s FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'missing source guard' USING ERRCODE='40001'; END IF;
  IF NOT pol.alive THEN RAISE EXCEPTION 'deleted source'; END IF;
  g := nextval('public.markdown_projection_clock');
  UPDATE public.markdown_projection_policy SET enabled=enabled_value,
    policy_generation=g,activation_watermark=g WHERE source_id=s;
  UPDATE public.markdown_projection_obligations SET status='blocked_policy' WHERE source_id=s;
END $$;

CREATE FUNCTION public.markdown_projection_record(p public.pages, tombstone boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE pol public.markdown_projection_policy; ident uuid; g bigint;
BEGIN
  pol := public.markdown_projection_admit(p.source_id);
  IF NOT pol.alive OR NOT pol.enabled THEN RETURN; END IF;
  -- Non-markdown transition must retire a previously enrolled markdown identity.
  IF p.page_kind <> 'markdown' AND NOT EXISTS (
    SELECT 1 FROM public.markdown_projection_obligations WHERE page_id=p.id AND source_id=p.source_id
  ) THEN RETURN; END IF;
  INSERT INTO public.markdown_projection_identity(page_id) VALUES(p.id) ON CONFLICT DO NOTHING;
  SELECT incarnation INTO ident FROM public.markdown_projection_identity WHERE page_id=p.id;
  g := nextval('public.markdown_projection_clock');
  INSERT INTO public.markdown_projection_obligations AS o
    (source_id,incarnation,page_id,generation,policy_generation,operation,desired_slug)
  VALUES(p.source_id,ident,p.id,g,pol.policy_generation,
    CASE WHEN tombstone OR p.deleted_at IS NOT NULL OR p.page_kind <> 'markdown' THEN 'tombstone' ELSE 'upsert' END,p.slug)
  ON CONFLICT(source_id,incarnation) DO UPDATE SET
    generation=g,policy_generation=pol.policy_generation,operation=excluded.operation,
    prior_slugs=CASE WHEN o.desired_slug<>excluded.desired_slug
      THEN array_append(o.prior_slugs,o.desired_slug) ELSE o.prior_slugs END,
    desired_slug=excluded.desired_slug,status='pending';
END $$;
CREATE FUNCTION public.markdown_projection_pages_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    PERFORM public.markdown_projection_lock_sources(ARRAY[OLD.source_id]);
    INSERT INTO public.markdown_projection_deleting(xid,page_id,incarnation)
    VALUES(txid_current(),OLD.id,COALESCE((SELECT incarnation FROM public.markdown_projection_identity WHERE page_id=OLD.id),gen_random_uuid()))
    ON CONFLICT DO NOTHING;
    PERFORM public.markdown_projection_record(OLD,true);
    DELETE FROM public.markdown_projection_identity WHERE page_id=OLD.id;
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' THEN
    IF OLD.id<>NEW.id THEN RAISE EXCEPTION 'immutable page identity'; END IF;
    IF ROW(OLD.source_id,OLD.slug,OLD.type,OLD.page_kind,OLD.title,OLD.compiled_truth,
      OLD.timeline,OLD.frontmatter,OLD.deleted_at,OLD.created_at)
      IS NOT DISTINCT FROM ROW(NEW.source_id,NEW.slug,NEW.type,NEW.page_kind,NEW.title,
      NEW.compiled_truth,NEW.timeline,NEW.frontmatter,NEW.deleted_at,NEW.created_at) THEN RETURN NEW; END IF;
    PERFORM public.markdown_projection_lock_sources(ARRAY[OLD.source_id,NEW.source_id]);
    IF OLD.source_id<>NEW.source_id THEN PERFORM public.markdown_projection_record(OLD,true); END IF;
  END IF;
  PERFORM public.markdown_projection_record(NEW,false);
  RETURN NEW;
END $$;
-- INSERT/UPDATE recording is AFTER the actual result (ON CONFLICT must not
-- create obligations for a speculative insert that did not become a page).
CREATE TRIGGER mp_changed AFTER INSERT OR UPDATE ON public.pages
FOR EACH ROW EXECUTE FUNCTION public.markdown_projection_pages_changed();
CREATE TRIGGER mp_deleting BEFORE DELETE ON public.pages
FOR EACH ROW EXECUTE FUNCTION public.markdown_projection_pages_changed();
CREATE FUNCTION public.markdown_projection_tags_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE p public.pages; parents public.pages[] := '{}'; ids integer[] := '{}'; i integer; srcs text[] := '{}';
BEGIN
  IF TG_OP <> 'INSERT' THEN ids := array_append(ids,OLD.page_id); END IF;
  IF TG_OP <> 'DELETE' THEN ids := array_append(ids,NEW.page_id); END IF;
  FOR i IN SELECT DISTINCT x FROM unnest(ids) AS u(x) ORDER BY x LOOP
    SELECT * INTO p FROM public.pages WHERE id=i FOR SHARE;
    IF NOT FOUND THEN
      IF TG_OP='DELETE' AND EXISTS(SELECT 1 FROM public.markdown_projection_deleting WHERE xid=txid_current() AND page_id=i) THEN
        CONTINUE; -- page BEFORE DELETE already recorded/fenced the tombstone
      END IF;
      RAISE EXCEPTION 'missing tag parent or deletion authority' USING ERRCODE='40001';
    END IF;
    parents := array_append(parents,p); srcs := array_append(srcs,p.source_id);
  END LOOP;
  PERFORM public.markdown_projection_lock_sources(srcs);
  FOREACH p IN ARRAY parents LOOP PERFORM public.markdown_projection_record(p,false); END LOOP;
  RETURN NULL;
END $$;
CREATE TRIGGER mp_changed AFTER INSERT OR UPDATE OR DELETE ON public.tags
FOR EACH ROW EXECUTE FUNCTION public.markdown_projection_tags_changed();
CREATE FUNCTION public.markdown_projection_deletion_cleanup() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  DELETE FROM public.markdown_projection_deleting WHERE xid=NEW.xid AND page_id=NEW.page_id;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER mp_deletion_cleanup AFTER INSERT ON public.markdown_projection_deleting
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.markdown_projection_deletion_cleanup();
-- BEFORE source deletion fences all retained work before any FK cascade.
-- Tombstones retain old generation/history; disabling never grants FS cleanup.
CREATE FUNCTION public.markdown_projection_source_deleted() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM 1 FROM public.markdown_projection_policy WHERE source_id=OLD.id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'missing source guard' USING ERRCODE='40001'; END IF;
  UPDATE public.markdown_projection_policy SET alive=false,enabled=false,
    policy_generation=nextval('public.markdown_projection_clock') WHERE source_id=OLD.id;
  UPDATE public.markdown_projection_obligations SET status='blocked_policy',operation='tombstone' WHERE source_id=OLD.id;
  RETURN OLD;
END $$;
CREATE TRIGGER mp_source_deleted BEFORE DELETE ON public.sources
FOR EACH ROW EXECUTE FUNCTION public.markdown_projection_source_deleted();
CREATE FUNCTION public.markdown_projection_source_created() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE g bigint;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF OLD.id<>NEW.id THEN RAISE EXCEPTION 'immutable source identity'; END IF;
    RETURN NEW;
  END IF;
  g := nextval('public.markdown_projection_clock');
  INSERT INTO public.markdown_projection_policy(source_id,policy_generation,activation_watermark)
  VALUES(NEW.id,g,g)
  ON CONFLICT(source_id) DO UPDATE SET source_incarnation=gen_random_uuid(),alive=true,
    enabled=false,policy_generation=g,activation_watermark=g;
  RETURN NEW;
END $$;
CREATE TRIGGER mp_source_created AFTER INSERT OR UPDATE ON public.sources
FOR EACH ROW EXECUTE FUNCTION public.markdown_projection_source_created();
REVOKE ALL ON FUNCTION public.markdown_projection_publish_lock(text),
 public.markdown_projection_admit(text), public.markdown_projection_lock_sources(text[]),
 public.markdown_projection_statement_lock(), public.markdown_projection_set_policy(text,boolean),
 public.markdown_projection_record(public.pages,boolean), public.markdown_projection_pages_changed(),
 public.markdown_projection_tags_changed(), public.markdown_projection_source_deleted(),
 public.markdown_projection_source_created(), public.markdown_projection_deletion_cleanup() FROM PUBLIC;
COMMIT;
