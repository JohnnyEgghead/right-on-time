// SPDX-License-Identifier: AGPL-3.0-or-later
// The auth stack suite's fixture rows, as SQL on stdout (ci/auth-stack.sh pipes it into psql once the stack is up):
//   node ci/auth-stack/fixture.ts            reads BW_AUTH_STACK_SEED (the stack's SAMPLE_PASSWORD_SEED) and BW_AUTH_STACK_REVIEWER
// The default stack holds the migrated schema and no rows (setup and the sample data are later lanes'), so the suite writes, as
// setup will: the clock row, 1 branch and the users the sign-in screens list, each with the scrypt hash the real seed writes
// (SD-9: a sample person's password derives from the seed and the email; this file hashes it with the package's own helpers).
// No password or secret is printed except inside the SQL, which goes to psql and nowhere else.
import { hashPassword, samplePassword } from '../../packages/db/src/passwords.ts';

const seed = process.env.BW_AUTH_STACK_SEED;
const reviewer = process.env.BW_AUTH_STACK_REVIEWER;
if (!seed || !reviewer) {
  console.error('fixture: BW_AUTH_STACK_SEED and BW_AUTH_STACK_REVIEWER are required');
  process.exit(2);
}

export const USERS = [
  { email: 'dana.ruiz@brightwater.example', name: 'Dana Ruiz', role: 'manager', title: 'Director of Operations', employee: null, sample: true, status: 'active' },
  { email: 'keisha.t@brightwater.example', name: 'Keisha Thompson', role: 'office', title: 'Dispatcher', employee: null, sample: true, status: 'active' },
  { email: 'maria.santos@brightwater.example', name: 'Maria Santos', role: 'technician', title: null, employee: '40712', sample: true, status: 'active' },
  { email: 'derek.simmons@brightwater.example', name: 'Derek Simmons', role: 'technician', title: null, employee: null, sample: true, status: 'invited' },
  // A staff member who is not a sample person, for the password reset (UC-19) with demo mode off (ci/auth-stack/accounts.stack.ts); her
  // password derives from the seed as a sample person's does, and she is in no sample list.
  { email: 'nina.ford@brightwater.example', name: 'Nina Ford', role: 'office', title: 'Dispatcher', employee: null, sample: false, status: 'active' },
] as const;

const q = (v: string | null) => (v === null ? 'NULL' : `'${v.replaceAll("'", "''")}'`);
const out: string[] = [
  '\\set ON_ERROR_STOP on',
  'BEGIN;',
  `INSERT INTO system.demo_clock (id, demo_anchor, real_anchor, rate, paused, world_epoch, pbs_epoch, last_reset_real, last_write_real)
   VALUES (1, '2026-09-15T14:41:00Z', now(), 1, false, 1, 1, now(), now());`,
  `INSERT INTO world.branch (id, name_key, zone, office_phone, depot_lon, depot_lat, map_file)
   VALUES ('columbus', 'branch.columbus', 'America/New_York', '(614) 555-0100', -83.0, 39.96, 'columbus.pmtiles'),
          -- P4-ACCOUNTS: UC-18 invites a Dayton technician (FR-AUTH-12's criterion).
          ('dayton', 'branch.dayton', 'America/New_York', '(937) 555-0101', -84.19, 39.76, 'dayton.pmtiles');`,
];
for (const u of USERS) {
  const hash = u.status === 'invited' ? null : await hashPassword(samplePassword(seed, u.email));
  out.push(`INSERT INTO world."user" (email, name, name_search, password_hash, role, branch_id, language, status, employee_number, title, sample, reviewer)
   VALUES (${q(u.email)}, ${q(u.name)}, ${q(u.name.toLowerCase())}, ${q(hash)}, '${u.role}', 'columbus', 'en', '${u.status}', ${q(u.employee)}, ${q(u.title)}, ${u.sample}, false);`);
}
out.push(`INSERT INTO world."user" (email, name, name_search, password_hash, role, branch_id, language, status, sample, reviewer)
   VALUES ('reviewer@brightwater.example', 'App Reviewer', 'app reviewer', ${q(await hashPassword(reviewer))}, 'technician', 'columbus', 'en', 'active', false, true);`);
out.push('COMMIT;');
process.stdout.write(out.join('\n') + '\n');
