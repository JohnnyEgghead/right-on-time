-- SPDX-License-Identifier: AGPL-3.0-or-later
-- P4-LOAD: grow the seeded world to the load day of REQUIREMENTS section 5.2 on a throwaway stack (never the public demo world).
-- The seeded Sep 15 holds 85 jobs and 21 technicians; the load day holds 600 jobs, 85 technicians and 14 dispatchers. Every added
-- person and job is generated here and labeled "Load": generated sample data only. The branches keep the seed's rough shares.
-- Each added job gets baked legs copied from the branch's own tracks, so API-21's route member and API-20's ETA read what a baked
-- day holds (F-817 is about that size). The autopilot steps are skipped: the load script is the technicians. The snapshot is
-- written again last, so API-14 restores this world between runs. Run once, as the schema owner, after setup.
\set ON_ERROR_STOP on
BEGIN;

CREATE TEMP TABLE load_branch (branch text PRIMARY KEY, techs int NOT NULL, jobs int NOT NULL, dispatchers int NOT NULL) ON COMMIT DROP;
INSERT INTO load_branch VALUES ('columbus', 46, 325, 7), ('dayton', 28, 205, 5), ('springfield', 11, 70, 2);

DO $$
DECLARE
  b record;
  tmpl world.technician;
  zone_name text;
  van uuid; usr uuid; tech uuid;
  added int; job_count int; job_left int; here int; spacing int;
  t_no int := 0; d_no int := 0; c_no int := 0; tr_no int := 0;
  customers uuid[];
  svc record;
  arrive timestamp; win_from time; win record; num int; prev text; tr record;
BEGIN
  FOR b IN SELECT * FROM load_branch ORDER BY branch LOOP
    SELECT * INTO tmpl FROM world.technician WHERE branch_id = b.branch ORDER BY id LIMIT 1;
    SELECT zone INTO zone_name FROM world.branch WHERE id = b.branch;
    SELECT b.techs - count(*) INTO added FROM world.technician WHERE branch_id = b.branch;
    SELECT b.jobs - count(*) INTO job_count FROM world.job WHERE branch_id = b.branch AND date = '2026-09-15';
    job_left := job_count;
    SELECT array_agg(id ORDER BY id) INTO customers FROM world.customer WHERE branch_id = b.branch AND status = 'active';
    FOR i IN 1..added LOOP
      t_no := t_no + 1;
      INSERT INTO world.van (branch_id, number, vehicle) VALUES (b.branch, 'L' || t_no, 'Ford Transit 250') RETURNING id INTO van;
      INSERT INTO world."user" (email, name, name_search, role, branch_id, language, status, sample, reviewer)
        VALUES ('load.tech.' || t_no || '@brightwater.example', 'Load Tech ' || t_no, 'load tech ' || t_no, 'technician', b.branch, 'en', 'active', false, false)
        RETURNING id INTO usr;
      INSERT INTO world.technician (user_id, branch_id, name, name_in_texts, phone, primary_skill, skills, installer, van_id, shift_start, shift_end, working_days, saturdays, since)
        VALUES (usr, b.branch, 'Load Tech ' || t_no, 'Load', tmpl.phone, tmpl.primary_skill, tmpl.skills, false, van, '08:00', '18:00', tmpl.working_days, tmpl.saturdays, tmpl.since)
        RETURNING id INTO tech;
      -- An even share of the branch's added jobs.
      here := ceil(job_left::numeric / (added - i + 1));
      -- Each technician's own spacing is 66 to 75 minutes. A 9-job day tightens it to 66 minutes, so its last job starts by 4:58 PM and ends by 6:00 PM.
      spacing := least(66 + (t_no * 3) % 10, 530 / greatest(here - 1, 1));
      job_left := job_left - here;
      prev := 'depot';
      FOR k IN 0..(here - 1) LOOP
        SELECT id, expected_minutes INTO svc FROM world.service_type WHERE expected_minutes <= 60 ORDER BY id OFFSET (c_no % 4) LIMIT 1;
        -- A real day is not synchronized (owner, Nov 13, 2026): each technician starts 0 to 10 minutes after 8:00 AM, so the
        -- branch's arrivals do not all land on one minute.
        arrive := timestamp '2026-09-15 08:00' + make_interval(mins => (t_no * 7) % 11 + spacing * k);
        -- F-1508: refuse a job that would run past the technicians' end (18:00, shift_end above) instead of wrapping it.
        IF arrive + svc.expected_minutes * interval '1 minute' > timestamp '2026-09-15 18:00' THEN
          RAISE EXCEPTION 'load fixture: technician % job % arrives at % and runs % minutes, past 18:00', t_no, k + 1, arrive, svc.expected_minutes;
        END IF;
        win_from := make_time(8 + 2 * ((extract(hour FROM arrive)::int - 8) / 2), 0, 0);
        SELECT w.id INTO win FROM world.arrival_window w WHERE w.branch_id = b.branch AND w.mode = 'two_hour' AND w.start_local = win_from
          ORDER BY w.id LIMIT 1;
        c_no := c_no + 1;
        INSERT INTO world.job (customer_id, branch_id, service_id, date, zone, window_id, window_start, window_end, technician_id, status, version,
                               planned_arrival, expected_minutes, booked_via, booked_at, billing_state, autopilot, touched_by_person, pilot)
          VALUES (customers[1 + (c_no * 37) % cardinality(customers)], b.branch, svc.id, '2026-09-15', zone_name, win.id,
                  ('2026-09-15 ' || win_from)::timestamp AT TIME ZONE zone_name, ('2026-09-15 ' || (win_from + interval '2 hours'))::timestamp AT TIME ZONE zone_name,
                  tech, 'scheduled', 1, arrive AT TIME ZONE zone_name, svc.expected_minutes, 'online', timestamptz '2026-09-10 09:00-04', 'not_sent', false, false, false)
          RETURNING job_number INTO num;
        INSERT INTO world.job_change (job_number, at, actor_user_id, actor_kind, kind, from_version, to_version, data)
          VALUES (num, timestamptz '2026-09-10 09:00-04', NULL, 'customer', 'created', 0, 1, '{"via":"online"}');
        tr_no := tr_no + 1;
        SELECT polyline, seconds, distance_m, build_id INTO tr FROM world.van_track WHERE branch_id = b.branch ORDER BY length(polyline) DESC, id OFFSET (tr_no % 40) LIMIT 1;
        INSERT INTO world.van_track (branch_id, from_ref, to_ref, polyline, seconds, distance_m, build_id) VALUES (b.branch, prev, num::text, tr.polyline, tr.seconds, tr.distance_m, tr.build_id);
        prev := num::text;
      END LOOP;
    END LOOP;
    FOR i IN 1..b.dispatchers LOOP
      d_no := d_no + 1;
      INSERT INTO world."user" (email, name, name_search, role, branch_id, language, status, title, sample, reviewer)
        VALUES ('load.dispatcher.' || d_no || '@brightwater.example', 'Load Dispatcher ' || d_no, 'load dispatcher ' || d_no, 'office', b.branch, 'en', 'active', 'Dispatcher', false, false);
    END LOOP;
  END LOOP;
END $$;

UPDATE world.scheduled_event SET state = 'skipped', result = 'load_day' WHERE kind = 'autopilot.step' AND state = 'due';
-- The seed has 1 technician still at invited (Chris Yoder, with a job on the day); on the load day every technician is signed in.
UPDATE world."user" SET status = 'active' WHERE status = 'invited' AND id IN (SELECT user_id FROM world.technician);

-- The checks that make this the load day, then the snapshot API-14 restores.
DO $$
DECLARE t text; n int;
BEGIN
  SELECT count(*) INTO n FROM world.job WHERE date = '2026-09-15' AND status <> 'canceled';
  IF n <> 600 THEN RAISE EXCEPTION 'load fixture: % jobs on the load day, not 600', n; END IF;
  SELECT count(*) INTO n FROM world.technician;
  IF n <> 85 THEN RAISE EXCEPTION 'load fixture: % technicians, not 85', n; END IF;
  SELECT count(*) INTO n FROM world."user" WHERE email LIKE 'load.dispatcher.%';
  IF n <> 14 THEN RAISE EXCEPTION 'load fixture: % dispatchers, not 14', n; END IF;
  FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace WHERE s.nspname = 'world' AND c.relkind IN ('r', 'p') ORDER BY 1 LOOP
    EXECUTE format('TRUNCATE world_snapshot.%I', t);
    EXECUTE format('INSERT INTO world_snapshot.%I SELECT * FROM world.%I', t, t);
  END LOOP;
END $$;
COMMIT;
