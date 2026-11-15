-- P2-SCHEMA. Indexes on every list's filter columns (SPECIFICATIONS section 11.5, "Performance and capacity"),
-- named by the list they serve. Forward-only (SD-40). Plain CREATE INDEX (not CONCURRENTLY): every migration runs in
-- 1 transaction, and these tables are empty when this file first applies.

-- API-111 street picker: prefix and trigram search on name_search (section 6.1), per branch.
CREATE INDEX street_name_search_trgm ON world.street USING gin (name_search public.gin_trgm_ops);
CREATE INDEX street_name_search_prefix ON world.street (name_search text_pattern_ops);
CREATE INDEX street_branch_city ON world.street (branch_id, city);

-- API-34 customer search: name by substring (trigram), street, phone; filters branch, city (via street), plan
-- (membership primary key), text language, upcoming visit (job by customer and date).
CREATE INDEX customer_name_search_trgm ON world.customer USING gin (name_search public.gin_trgm_ops);
CREATE INDEX customer_branch ON world.customer (branch_id);
CREATE INDEX customer_street ON world.customer (street_id, house_number);
CREATE INDEX customer_mobile ON world.customer (mobile);
CREATE INDEX customer_home_phone ON world.customer (home_phone);
CREATE INDEX customer_text_language ON world.customer (branch_id, text_language);
CREATE INDEX customer_inbox_token ON world.customer (inbox_token);  -- the inbox route's lookup (FR-TEXT-14)
CREATE INDEX equipment_customer ON world.equipment (customer_id);

-- API-107 parts search on the phone copy, and by code (unique already).
CREATE INDEX part_name_search_trgm ON world.part USING gin (name_search public.gin_trgm_ops);

-- API-20 board and API-133 jobs list: tab, date, branch, technician, status, service, query (job number = key);
-- the Not in billing tab lists retrying and waiting_person jobs whatever their date (UD-44).
CREATE INDEX job_branch_date ON world.job (branch_id, date);
CREATE INDEX job_technician_date ON world.job (technician_id, date);
CREATE INDEX job_customer_date ON world.job (customer_id, date);
CREATE INDEX job_branch_status_date ON world.job (branch_id, status, date);
CREATE INDEX job_service_date ON world.job (service_id, date);
CREATE INDEX job_not_in_billing ON world.job (branch_id, billing_state) WHERE billing_state IN ('retrying', 'waiting_person');
CREATE INDEX job_booking_token ON world.job (booking_token) WHERE booking_token IS NOT NULL;  -- API-114
CREATE INDEX job_pilot_date ON world.job (date) WHERE pilot;  -- report_visit's pilot rows (SD-25)

-- Technician pages and day plans.
CREATE INDEX technician_branch ON world.technician (branch_id);
CREATE INDEX technician_user ON world.technician (user_id);
CREATE INDEX van_branch ON world.van (branch_id);
CREATE INDEX time_off_technician_dates ON world.time_off (technician_id, from_date, to_date);
CREATE INDEX time_block_technician_date ON world.time_block (technician_id, date);
CREATE INDEX arrival_window_branch_mode ON world.arrival_window (branch_id, mode);

-- API-23 timeline and the finish lines.
CREATE INDEX job_change_job_at ON world.job_change (job_number, at);
CREATE INDEX note_job ON world.note (job_number) WHERE job_number IS NOT NULL;
CREATE INDEX note_customer ON world.note (customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX photo_job ON world.photo (job_number);
CREATE INDEX tech_item_technician_received ON world.tech_item (technician_id, received_at);
CREATE INDEX tech_item_job ON world.tech_item (job_number);
CREATE INDEX offline_conflict_branch_open ON world.offline_conflict (branch_id) WHERE handled_at IS NULL;  -- flagged
CREATE INDEX offline_conflict_job ON world.offline_conflict (job_number);

-- API-40 and API-146 text log: date, branch (via customer), type, status, language, customerId.
CREATE INDEX outbox_text_due ON world.outbox_text (due_at);
CREATE INDEX outbox_text_customer_due ON world.outbox_text (customer_id, due_at);
CREATE INDEX outbox_text_job ON world.outbox_text (job_number) WHERE job_number IS NOT NULL;
CREATE INDEX outbox_text_status_due ON world.outbox_text (status, due_at);
CREATE INDEX outbox_text_kind_due ON world.outbox_text (kind, due_at);
CREATE INDEX outbox_text_language_due ON world.outbox_text (language, due_at);
CREATE INDEX inbox_message_customer_at ON world.inbox_message (customer_id, at);
CREATE INDEX link_token_job ON world.link_token (job_number);

-- API-42 call list: branch and date.
CREATE INDEX call_list_entry_branch_date ON world.call_list_entry (branch_id, call_date);
CREATE INDEX call_list_entry_text ON world.call_list_entry (text_id) WHERE text_id IS NOT NULL;  -- already_on_call_list

-- The event dispatcher claims due rows in (due_at, id) order (FR-DEMO-3).
CREATE INDEX scheduled_event_due ON world.scheduled_event (due_at, id) WHERE state = 'due';
CREATE INDEX scheduled_event_kind_subject ON world.scheduled_event (kind, subject);

-- API-60 billing queue: state; leftLast7Days by left_at.
CREATE INDEX billing_item_state ON world.billing_item (state);
CREATE INDEX billing_item_left_at ON world.billing_item (left_at) WHERE left_at IS NOT NULL;

-- Import: API-81 history, API-85 duplicates by status, API-83 problems by run (primary key leads with run_id).
CREATE INDEX import_run_started ON world.import_run (started_at);
CREATE INDEX duplicate_pair_run_status ON world.duplicate_pair (run_id, status);
CREATE INDEX duplicate_pair_status ON world.duplicate_pair (status);
CREATE INDEX merge_pair ON world."merge" (pair_id);

-- Reports (SD-25) and customer history (lastVisit).
CREATE INDEX past_visit_customer_date ON world.past_visit (customer_id, date);
CREATE INDEX past_visit_date ON world.past_visit (date);
CREATE INDEX past_visit_technician ON world.past_visit (technician_id) WHERE technician_id IS NOT NULL;
CREATE INDEX pilot_call_branch_at ON world.pilot_call (branch_id, at);
CREATE INDEX pilot_call_technician ON world.pilot_call (technician_id);

-- API-149 users: query, role, branch, status; API-154 recent user changes.
CREATE INDEX user_branch_role_status ON world."user" (branch_id, role, status);
CREATE INDEX user_role_status ON world."user" (role, status);
CREATE INDEX user_change_at ON world.user_change (at);
CREATE INDEX user_change_user ON world.user_change (user_id, at);
CREATE INDEX password_token_user ON world.password_token (user_id);
CREATE INDEX email_message_user_sent ON world.email_message (user_id, sent_at);
CREATE INDEX email_link_email ON world.email_link (email_id);

-- API-43 alerts: branch and date; state.
CREATE INDEX alert_branch_at ON world.alert (branch_id, at);
CREATE INDEX alert_state_at ON world.alert (state, at);

-- Map tracks per branch and stop pair.
CREATE INDEX van_track_branch_stops ON world.van_track (branch_id, from_ref, to_ref);

-- pbs: callsReceived (API-66) by job.
CREATE INDEX call_job ON pbs."call" (job_number, at);

-- system: session lookups by user; cleanup by epoch and age.
CREATE INDEX session_by_user ON system.session (user_id);
CREATE INDEX session_expires ON system.session (expires_real);
CREATE INDEX clock_move_epoch ON system.clock_move (world_epoch, at_real);
CREATE INDEX delay_sample_emitted ON system.delay_sample (emitted_real);
CREATE INDEX backup_record_kind_started ON system.backup_record (kind, started_real);
