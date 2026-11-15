-- P2-KERNEL (F-150). The login of each process: web and worker sign in as members of role app, pbs as a member of
-- role pbs, so the privileges stay exactly the ones 0007 grants to the 2 NOLOGIN roles, and each process can be told
-- apart (and its login turned off) on its own. No password here: the migrate step sets each login's password from a
-- file only that step and that process can read (packages/db/src/logins.ts); a login with no password cannot sign in.
-- Forward-only (SD-40).
DO $$
BEGIN
  BEGIN
    CREATE ROLE bw_web LOGIN IN ROLE app;
  EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
  END;
  BEGIN
    CREATE ROLE bw_worker LOGIN IN ROLE app;
  EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
  END;
  BEGIN
    CREATE ROLE bw_pbs LOGIN IN ROLE pbs;
  EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
  END;
END
$$;
