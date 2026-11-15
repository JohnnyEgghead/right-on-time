-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Known-bad (OI-57, invariant 1, SD-12): parity compares keys both ways.
--   job.customer_id loses its foreign key (the key OI-57's setup order depends on);
--   tech_item loses its primary key (invariant 1), and with it the 2 foreign keys that reference it;
--   system.session.user_id gains a cross-store foreign key section 3 says must not exist (a reset truncates world).
ALTER TABLE world.job DROP CONSTRAINT job_customer_id_fkey;
ALTER TABLE world.tech_item DROP CONSTRAINT tech_item_pkey CASCADE;
ALTER TABLE system.session ADD CONSTRAINT session_user_id_fkey FOREIGN KEY (user_id) REFERENCES world."user" (id);
