-- P3-ITEMS (F-384; SPECIFICATIONS section 6.6 FR-BILL-1 and FR-BILL-3, invariant 10). Forward-only (SD-40).
-- Every path that sets a job to done bills it in the same transaction (billFinishedJob writes its billing_item, after
-- the finishLines validator and its stored-lines check). G-CI10's finish-path check can only enumerate the finish
-- routes the spec names; this constraint holds every other writer to the same rule: a transaction that moves a job
-- into status done and commits with no billing_item for it fails at commit. Deferred, so the billing item may come
-- after the status write inside the transaction. Rows inserted as done (the seed, a reset's restore) are not moves.
CREATE FUNCTION world.job_done_needs_billing_item() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM world.job WHERE job_number = NEW.job_number AND status = 'done')
     AND NOT EXISTS (SELECT 1 FROM world.billing_item WHERE job_number = NEW.job_number) THEN
    RAISE EXCEPTION 'job % was set to done with no billing item (every finish path bills it: FR-BILL-1)', NEW.job_number
      USING ERRCODE = 'check_violation', CONSTRAINT = 'job_done_needs_billing_item';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER job_done_needs_billing_item
  AFTER UPDATE OF status ON world.job
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW.status = 'done' AND OLD.status IS DISTINCT FROM 'done')
  EXECUTE FUNCTION world.job_done_needs_billing_item();
