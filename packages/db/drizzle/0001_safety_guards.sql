-- The frozen state machine is enforced for all writers, including SQL clients.
CREATE FUNCTION guard_session_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'triaging' AND NEW.status IN ('waiting','escalated','closed')) OR
    (OLD.status = 'waiting' AND NEW.status IN ('escalated','served','green_lane','closed')) OR
    (OLD.status = 'escalated' AND NEW.status IN ('served','closed')) OR
    (OLD.status = 'green_lane' AND NEW.status IN ('closed','escalated')) OR
    (OLD.status = 'served' AND NEW.status = 'closed')
  ) THEN RAISE EXCEPTION 'Illegal session transition: % -> %', OLD.status, NEW.status; END IF;
  IF OLD.priority IS NOT NULL AND (NEW.priority IS NULL OR NEW.priority > OLD.priority) THEN
    RAISE EXCEPTION 'Session priority cannot de-escalate';
  END IF;
  IF OLD.wants_human AND NOT NEW.wants_human THEN RAISE EXCEPTION 'Human request cannot be cleared'; END IF;
  IF OLD.is_emergency AND NOT NEW.is_emergency THEN RAISE EXCEPTION 'Emergency cannot be cleared'; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER sessions_guard BEFORE UPDATE ON sessions FOR EACH ROW EXECUTE FUNCTION guard_session_update();
--> statement-breakpoint
CREATE FUNCTION reject_triage_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'triage_results is append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER triage_results_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON triage_results FOR EACH STATEMENT EXECUTE FUNCTION reject_triage_mutation();
