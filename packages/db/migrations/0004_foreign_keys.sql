-- P2-SCHEMA. Every foreign key of SPECIFICATIONS section 3 ("Nullability and keys"). Forward-only (SD-40).
-- Declared only within a store (world to world, pbs to pbs), so a reset truncates world without touching pbs or
-- system (SD-12). Inside world: <table>_id references <table>.id; job_number references job.job_number;
-- actor_user_id, author_user_id, user_id, manager_id and every *_by column reference user.id; item_key references
-- tech_item.key; plus the document's explicit references (job.service_id, alert_email_link.email_link_hash) and the
-- readings in REFERENCE_INTERPRETATIONS (ci/gates/schema-gates/spec-model.ts). Not deferrable: job.customer_id
-- refuses a job whose customer does not exist yet, the order OI-57's setup depends on.

ALTER TABLE world.street
  ADD CONSTRAINT street_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES world.branch (id);
ALTER TABLE world.customer
  ADD CONSTRAINT customer_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES world.branch (id),
  ADD CONSTRAINT customer_street_id_fkey FOREIGN KEY (street_id) REFERENCES world.street (id),
  ADD CONSTRAINT customer_merged_into_fkey FOREIGN KEY (merged_into) REFERENCES world.customer (id);
ALTER TABLE world.membership
  ADD CONSTRAINT membership_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES world.customer (id);
ALTER TABLE world.equipment
  ADD CONSTRAINT equipment_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES world.customer (id);
ALTER TABLE world.technician
  ADD CONSTRAINT technician_user_id_fkey FOREIGN KEY (user_id) REFERENCES world."user" (id),
  ADD CONSTRAINT technician_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES world.branch (id),
  ADD CONSTRAINT technician_van_id_fkey FOREIGN KEY (van_id) REFERENCES world.van (id);
ALTER TABLE world.van
  ADD CONSTRAINT van_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES world.branch (id);
ALTER TABLE world.time_off
  ADD CONSTRAINT time_off_technician_id_fkey FOREIGN KEY (technician_id) REFERENCES world.technician (id),
  ADD CONSTRAINT time_off_created_by_fkey FOREIGN KEY (created_by) REFERENCES world."user" (id);
ALTER TABLE world.arrival_window
  ADD CONSTRAINT arrival_window_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES world.branch (id);
ALTER TABLE world.day_mode
  ADD CONSTRAINT day_mode_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES world.branch (id),
  ADD CONSTRAINT day_mode_switched_by_fkey FOREIGN KEY (switched_by) REFERENCES world."user" (id);
ALTER TABLE world.booking_day
  ADD CONSTRAINT booking_day_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES world.branch (id);
ALTER TABLE world.job
  ADD CONSTRAINT job_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES world.customer (id),
  ADD CONSTRAINT job_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES world.branch (id),
  ADD CONSTRAINT job_service_id_fkey FOREIGN KEY (service_id) REFERENCES world.service_type (id),
  ADD CONSTRAINT job_equipment_id_fkey FOREIGN KEY (equipment_id) REFERENCES world.equipment (id),
  ADD CONSTRAINT job_window_id_fkey FOREIGN KEY (window_id) REFERENCES world.arrival_window (id),
  ADD CONSTRAINT job_technician_id_fkey FOREIGN KEY (technician_id) REFERENCES world.technician (id),
  ADD CONSTRAINT job_booked_by_fkey FOREIGN KEY (booked_by) REFERENCES world."user" (id);
ALTER TABLE world.technician_day
  ADD CONSTRAINT technician_day_technician_id_fkey FOREIGN KEY (technician_id) REFERENCES world.technician (id);
ALTER TABLE world.text_simulator
  ADD CONSTRAINT text_simulator_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES world.customer (id),
  ADD CONSTRAINT text_simulator_set_by_fkey FOREIGN KEY (set_by) REFERENCES world."user" (id);
ALTER TABLE world.job_part
  ADD CONSTRAINT job_part_job_number_fkey FOREIGN KEY (job_number) REFERENCES world.job (job_number),
  ADD CONSTRAINT job_part_part_id_fkey FOREIGN KEY (part_id) REFERENCES world.part (id);
ALTER TABLE world.work_done_line
  ADD CONSTRAINT work_done_line_job_number_fkey FOREIGN KEY (job_number) REFERENCES world.job (job_number);
ALTER TABLE world.job_change
  ADD CONSTRAINT job_change_job_number_fkey FOREIGN KEY (job_number) REFERENCES world.job (job_number),
  ADD CONSTRAINT job_change_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES world."user" (id);
ALTER TABLE world.time_block
  ADD CONSTRAINT time_block_technician_id_fkey FOREIGN KEY (technician_id) REFERENCES world.technician (id);
ALTER TABLE world.note
  ADD CONSTRAINT note_job_number_fkey FOREIGN KEY (job_number) REFERENCES world.job (job_number),
  ADD CONSTRAINT note_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES world.customer (id),
  ADD CONSTRAINT note_author_user_id_fkey FOREIGN KEY (author_user_id) REFERENCES world."user" (id),
  ADD CONSTRAINT note_item_key_fkey FOREIGN KEY (item_key) REFERENCES world.tech_item (key);
ALTER TABLE world.photo
  ADD CONSTRAINT photo_job_number_fkey FOREIGN KEY (job_number) REFERENCES world.job (job_number),
  ADD CONSTRAINT photo_technician_id_fkey FOREIGN KEY (technician_id) REFERENCES world.technician (id);
ALTER TABLE world.signature
  ADD CONSTRAINT signature_job_number_fkey FOREIGN KEY (job_number) REFERENCES world.job (job_number);
ALTER TABLE world.tech_item
  ADD CONSTRAINT tech_item_technician_id_fkey FOREIGN KEY (technician_id) REFERENCES world.technician (id),
  ADD CONSTRAINT tech_item_job_number_fkey FOREIGN KEY (job_number) REFERENCES world.job (job_number);
ALTER TABLE world.offline_conflict
  ADD CONSTRAINT offline_conflict_job_number_fkey FOREIGN KEY (job_number) REFERENCES world.job (job_number),
  ADD CONSTRAINT offline_conflict_item_key_fkey FOREIGN KEY (item_key) REFERENCES world.tech_item (key),
  ADD CONSTRAINT offline_conflict_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES world.branch (id),
  ADD CONSTRAINT offline_conflict_handled_by_fkey FOREIGN KEY (handled_by) REFERENCES world."user" (id);
ALTER TABLE world.app_sync_report
  ADD CONSTRAINT app_sync_report_technician_id_fkey FOREIGN KEY (technician_id) REFERENCES world.technician (id);
ALTER TABLE world.outbox_text
  ADD CONSTRAINT outbox_text_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES world.customer (id),
  ADD CONSTRAINT outbox_text_job_number_fkey FOREIGN KEY (job_number) REFERENCES world.job (job_number),
  ADD CONSTRAINT outbox_text_sent_by_fkey FOREIGN KEY (sent_by) REFERENCES world."user" (id);
ALTER TABLE world.text_attempt
  ADD CONSTRAINT text_attempt_text_id_fkey FOREIGN KEY (text_id) REFERENCES world.outbox_text (id),
  ADD CONSTRAINT text_attempt_by_fkey FOREIGN KEY ("by") REFERENCES world."user" (id);
ALTER TABLE world.inbox_message
  ADD CONSTRAINT inbox_message_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES world.customer (id),
  ADD CONSTRAINT inbox_message_text_id_fkey FOREIGN KEY (text_id) REFERENCES world.outbox_text (id),
  ADD CONSTRAINT inbox_message_job_number_fkey FOREIGN KEY (job_number) REFERENCES world.job (job_number);
ALTER TABLE world.call_list_entry
  ADD CONSTRAINT call_list_entry_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES world.branch (id),
  ADD CONSTRAINT call_list_entry_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES world.customer (id),
  ADD CONSTRAINT call_list_entry_job_number_fkey FOREIGN KEY (job_number) REFERENCES world.job (job_number),
  ADD CONSTRAINT call_list_entry_text_id_fkey FOREIGN KEY (text_id) REFERENCES world.outbox_text (id),
  ADD CONSTRAINT call_list_entry_added_by_fkey FOREIGN KEY (added_by) REFERENCES world."user" (id),
  ADD CONSTRAINT call_list_entry_outcome_by_fkey FOREIGN KEY (outcome_by) REFERENCES world."user" (id);
ALTER TABLE world.link_token
  ADD CONSTRAINT link_token_job_number_fkey FOREIGN KEY (job_number) REFERENCES world.job (job_number);
ALTER TABLE world.billing_item
  ADD CONSTRAINT billing_item_job_number_fkey FOREIGN KEY (job_number) REFERENCES world.job (job_number),
  ADD CONSTRAINT billing_item_left_by_fkey FOREIGN KEY (left_by) REFERENCES world."user" (id);
ALTER TABLE world.billing_attempt
  ADD CONSTRAINT billing_attempt_job_number_fkey FOREIGN KEY (job_number) REFERENCES world.job (job_number);
ALTER TABLE world.import_run
  ADD CONSTRAINT import_run_by_user_fkey FOREIGN KEY (by_user) REFERENCES world."user" (id);
ALTER TABLE world.import_problem_row
  ADD CONSTRAINT import_problem_row_run_id_fkey FOREIGN KEY (run_id) REFERENCES world.import_run (id);
ALTER TABLE world.duplicate_pair
  ADD CONSTRAINT duplicate_pair_run_id_fkey FOREIGN KEY (run_id) REFERENCES world.import_run (id),
  ADD CONSTRAINT duplicate_pair_record_a_fkey FOREIGN KEY (record_a) REFERENCES world.customer (id),
  ADD CONSTRAINT duplicate_pair_record_b_fkey FOREIGN KEY (record_b) REFERENCES world.customer (id),
  ADD CONSTRAINT duplicate_pair_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES world."user" (id);
ALTER TABLE world."merge"
  ADD CONSTRAINT merge_pair_id_fkey FOREIGN KEY (pair_id) REFERENCES world.duplicate_pair (id);
ALTER TABLE world.past_visit
  ADD CONSTRAINT past_visit_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES world.customer (id),
  ADD CONSTRAINT past_visit_technician_id_fkey FOREIGN KEY (technician_id) REFERENCES world.technician (id);
ALTER TABLE world.pilot_call
  ADD CONSTRAINT pilot_call_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES world.branch (id),
  ADD CONSTRAINT pilot_call_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES world.customer (id),
  ADD CONSTRAINT pilot_call_technician_id_fkey FOREIGN KEY (technician_id) REFERENCES world.technician (id),
  ADD CONSTRAINT pilot_call_past_visit_id_fkey FOREIGN KEY (past_visit_id) REFERENCES world.past_visit (id),
  ADD CONSTRAINT pilot_call_job_number_fkey FOREIGN KEY (job_number) REFERENCES world.job (job_number);
ALTER TABLE world."user"
  ADD CONSTRAINT user_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES world.branch (id);
ALTER TABLE world.user_change
  ADD CONSTRAINT user_change_user_id_fkey FOREIGN KEY (user_id) REFERENCES world."user" (id),
  ADD CONSTRAINT user_change_by_fkey FOREIGN KEY ("by") REFERENCES world."user" (id);
ALTER TABLE world.password_token
  ADD CONSTRAINT password_token_user_id_fkey FOREIGN KEY (user_id) REFERENCES world."user" (id);
ALTER TABLE world.email_message
  ADD CONSTRAINT email_message_user_id_fkey FOREIGN KEY (user_id) REFERENCES world."user" (id);
ALTER TABLE world.email_link
  ADD CONSTRAINT email_link_email_id_fkey FOREIGN KEY (email_id) REFERENCES world.email_message (id),
  ADD CONSTRAINT email_link_shown_to_user_fkey FOREIGN KEY (shown_to_user) REFERENCES world."user" (id);
ALTER TABLE world.alert
  ADD CONSTRAINT alert_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES world.branch (id);
ALTER TABLE world.alert_email_link
  ADD CONSTRAINT alert_email_link_alert_id_fkey FOREIGN KEY (alert_id) REFERENCES world.alert (id),
  ADD CONSTRAINT alert_email_link_manager_id_fkey FOREIGN KEY (manager_id) REFERENCES world."user" (id),
  ADD CONSTRAINT alert_email_link_email_link_hash_fkey FOREIGN KEY (email_link_hash) REFERENCES world.email_link (token_hash);
ALTER TABLE world.alert_setting
  ADD CONSTRAINT alert_setting_set_by_fkey FOREIGN KEY (set_by) REFERENCES world."user" (id);
ALTER TABLE world.van_track
  ADD CONSTRAINT van_track_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES world.branch (id);
ALTER TABLE pbs.invoice_line
  ADD CONSTRAINT invoice_line_job_number_fkey FOREIGN KEY (job_number) REFERENCES pbs.invoice (job_number);

