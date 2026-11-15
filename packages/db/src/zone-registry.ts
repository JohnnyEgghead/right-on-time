// SPDX-License-Identifier: AGPL-3.0-or-later
// The schema registry's zone owners (SPECIFICATIONS section 3, Time rule, invariant 4). Every table that stores a
// timestamptz, date or time column names the zone its local reading uses:
//   column    the row's own `zone` text column (an IANA zone copied at write time: job, time_block, past_visit)
//   branch    the branch zone, found through `via` (branch_id, or a column that leads to a row that has one)
//   customer  the customer's zone, found through `via` (customer_id, or a column that leads to the customer)
//   utc       an instant with no local reading of its own: real-time system records, and demo-time queue and audit
//             instants that every page shows in its own branch zone
// A column whose name ends `_real` holds real time (SD-10) and needs no entry: it is an instant in UTC by name.
// schema-time-zone-check (ci/gates/schema-gates) fails a time column whose table has no entry here and no `_real`
// suffix, an entry for a table with no such column, an entry whose `via` column does not exist, and an entry that
// contradicts a "zone: branch" or "zone: customer" note in section 3.

export type ZoneOwner = 'column' | 'branch' | 'customer' | 'utc';

export interface ZoneDeclaration {
  owner: ZoneOwner;
  /** For branch and customer: the column through which the zone is found. */
  via?: string;
}

const branch = (via: string): ZoneDeclaration => ({ owner: 'branch', via });
const customer = (via: string): ZoneDeclaration => ({ owner: 'customer', via });
const column: ZoneDeclaration = { owner: 'column' };
const utc: ZoneDeclaration = { owner: 'utc' };

export const zoneRegistry: Readonly<Record<string, ZoneDeclaration>> = {
  // world: reference and planning rows, local dates and times in the branch zone
  'world.customer': branch('branch_id'), // customer_since: "zone: branch" (the row's own zone is for its texts)
  'world.membership': branch('customer_id'),
  'world.technician': branch('branch_id'),
  'world.time_off': branch('technician_id'),
  'world.arrival_window': branch('branch_id'),
  'world.day_mode': branch('branch_id'),
  'world.booking_day': branch('branch_id'),
  'world.job': column,
  'world.technician_day': branch('technician_id'),
  'world.time_block': column,
  'world.past_visit': column,
  // world: the visit's history and the phones' items, read on the job's branch board
  'world.job_change': branch('job_number'),
  'world.note': branch('job_number'), // or the customer's branch for a customer note (customer_id)
  'world.photo': branch('job_number'),
  'world.signature': branch('job_number'),
  'world.tech_item': branch('job_number'),
  'world.offline_conflict': branch('branch_id'),
  'world.app_sync_report': branch('technician_id'),
  'world.call_list_entry': branch('branch_id'),
  'world.billing_item': branch('job_number'),
  'world.billing_attempt': branch('job_number'),
  'world.pilot_call': branch('branch_id'),
  'world.user': branch('branch_id'),
  'world.alert': branch('branch_id'), // a system-wide alert (null branch) reads in the viewer's branch zone
  // world: customer-facing times, in the customer's zone (quiet hours, invariant 9)
  'world.outbox_text': customer('customer_id'),
  'world.text_attempt': customer('text_id'),
  'world.inbox_message': customer('customer_id'),
  'world.link_token': customer('job_number'),
  // world: queue, import, account and settings instants with no local reading of their own
  'world.text_simulator': utc,
  'world.scheduled_event': utc,
  'world.import_run': utc,
  'world.duplicate_pair': utc,
  'world.merge': utc,
  'world.user_change': utc,
  'world.time_block_change': utc, // P4-BOARD (owner ruling 8ef38e83): an audit instant, shown in its block's own zone
  'world.password_token': utc,
  'world.email_message': utc,
  'world.email_link': utc,
  'world.alert_setting': utc,
  // pbs: the billing system's invoice times read on the job's branch; its call log and mode are instants
  'pbs.invoice': branch('job_number'),
  'pbs.mode': utc,
  'pbs.call': utc,
  // system: the clock rows (demo-time anchors and moves are instants; their `_real` columns are real time)
  'system.demo_clock': utc,
  'system.clock_move': utc,
};
