-- P2-SCHEMA. The `pbs` and `system` tables of SPECIFICATIONS section 3. Forward-only (SD-40).
-- pbs.invoice is keyed by job number: 1 invoice per job ever (invariant 10, FR-BILL-8). The columns that name a
-- `world` row from these stores (pbs.invoice.job_number, entered_by; pbs.call.job_number; pbs.mode.set_by;
-- system.session.user_id) are plain values with no constraint, so a reset can truncate `world` alone (SD-12).

CREATE TABLE pbs.invoice (
  job_number              integer PRIMARY KEY,
  received_at             timestamptz NOT NULL,
  how                     text NOT NULL,
  total_cents             integer NOT NULL,
  customer_name           text NOT NULL,
  done_at                 timestamptz NOT NULL,
  entered_by_hand_reason  text,
  entered_by              uuid,
  entered_at              timestamptz
);

CREATE TABLE pbs.invoice_line (
  job_number    integer NOT NULL,
  seq           integer NOT NULL,
  kind          text NOT NULL,
  label         text NOT NULL,
  code          text,
  quantity      integer,
  unit_cents    integer,
  amount_cents  integer,
  PRIMARY KEY (job_number, seq)
);

-- 1 row (section 3).
CREATE TABLE pbs.mode (
  mode    text NOT NULL,
  n_left  integer,
  set_by  uuid,
  set_at  timestamptz,
  epoch   integer NOT NULL
);
CREATE UNIQUE INDEX mode_one_row ON pbs.mode ((true));

CREATE TABLE pbs."call" (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  job_number  integer NOT NULL,
  at          timestamptz NOT NULL,
  answer      text NOT NULL
);

-- The 1 clock row (D11): id is always 1.
CREATE TABLE system.demo_clock (
  id                 integer PRIMARY KEY CONSTRAINT demo_clock_id_is_1 CHECK (id = 1),
  demo_anchor        timestamptz NOT NULL,
  real_anchor        timestamptz NOT NULL,
  rate               numeric NOT NULL,
  paused             boolean NOT NULL,
  world_epoch        integer NOT NULL,
  pbs_epoch          integer NOT NULL,
  last_move_by_name  text,
  last_move_kind     text,
  last_move_to       timestamptz,
  last_move_real     timestamptz,
  replay_target      timestamptz,
  replay_done        integer NOT NULL DEFAULT 0,
  replay_total       integer NOT NULL DEFAULT 0,
  last_reset_real    timestamptz NOT NULL,
  last_write_real    timestamptz NOT NULL
);

CREATE TABLE system.clock_move (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  world_epoch  integer NOT NULL,
  at_real      timestamptz NOT NULL,
  from_demo    timestamptz NOT NULL,
  to_demo      timestamptz NOT NULL,
  kind         text NOT NULL,
  by_name      text NOT NULL
);

-- 1 row (id 1).
CREATE TABLE system.worker_heartbeat (
  id         integer PRIMARY KEY CONSTRAINT worker_heartbeat_id_is_1 CHECK (id = 1),
  beat_real  timestamptz NOT NULL
);

CREATE TABLE system.session (
  token_hash      bytea PRIMARY KEY,
  user_id         uuid NOT NULL,
  client          text NOT NULL,
  via             text NOT NULL,
  keep_signed_in  boolean NOT NULL,
  created_real    timestamptz NOT NULL,
  last_seen_real  timestamptz NOT NULL,
  expires_real    timestamptz NOT NULL
);

CREATE TABLE system.access_code (
  code_hash     text NOT NULL,
  active        boolean NOT NULL,
  created_real  timestamptz NOT NULL
);

CREATE TABLE system.day_snapshot (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  schema_name   text NOT NULL,
  created_real  timestamptz NOT NULL,
  label         text NOT NULL
);

CREATE TABLE system.backup_record (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  kind           text NOT NULL,
  location       text NOT NULL,
  started_real   timestamptz NOT NULL,
  finished_real  timestamptz,
  result         text,
  size_bytes     bigint,
  nights_kept    integer,
  manifest       jsonb
);

CREATE TABLE system.delay_sample (
  seq           bigint NOT NULL,
  emitted_real  timestamptz NOT NULL,
  acked_real    timestamptz NOT NULL,
  ms            integer NOT NULL
);
