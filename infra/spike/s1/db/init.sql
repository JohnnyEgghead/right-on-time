-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Spike S1: the 1 table the write route inserts into.
CREATE TABLE spike_write (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run        integer NOT NULL,
  branch_id  integer NOT NULL,
  written_at timestamptz NOT NULL DEFAULT now()
);
