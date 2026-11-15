// SPDX-License-Identifier: AGPL-3.0-or-later
// P8-RESTORE-DRILL: the drill's record (at BW_RESTORE_DRILL_RECORD for a run, F-1605), rendered from the results file restore-drill.sh writes as
// it goes (1 key=value per line; it never holds an address, a seed or a key).
//   node infra/drill/record.ts <results.env> > <record.md>
// The verdict is PASS only when every arm gave its required exit code, the bucket listing after equals the listing before, the
// instances after are exactly the instances before (the hosted server only), no drill key pair is left and the teardown finished.
// F-1584: an empty bucket listing (0 objects before or after) is named as empty and flagged on its own line. It does not change the
// verdict (the drill touches nothing hosted, so equal-and-empty is still equal), but it is never shown as a plain "unchanged".
// Times are shown in the owner's zone (America/New_York, labeled EST or EDT); the results file keeps epoch seconds.
import { readFileSync } from 'node:fs';
import { isMain } from '../../ci/is-main.ts';

export type Results = Record<string, string>;
export interface Arm { name: string; want: number; got: number | null }

export const ARM_WORDS: Record<string, string> = {
  backup: 'backup.sh on copy 1 (a fresh setup of the sample world; target local on the copy)',
  'restore-test-planted': 'restore-test.sh on copy 1 against a planted manifest (its known-bad, first)',
  'restore-test': 'restore-test.sh on copy 1 against the set',
  restore: 'restore-copy.sh restore on copy 2 (the operator procedure: pg_restore --clean, then every table compared with the manifest)',
  'check-planted': 'restore-copy.sh check on copy 2 against a planted manifest',
  smoke: 'the smoke sign-in on copy 2 (Maria Santos finds Harold Jenkins job 24830, 10:00 AM to 12:00 PM)',
};
export const ARM_ORDER = Object.keys(ARM_WORDS);

export function parseResults(text: string): Results {
  const out: Results = {};
  for (const line of text.split('\n')) {
    const m = /^([a-z0-9_]+)=(.*)$/.exec(line);
    if (m) out[m[1] as string] = m[2] as string;
  }
  return out;
}

/** Each arm in ARM_ORDER with its required and measured exit code (null: the arm never ran). */
export function arms(r: Results): Arm[] {
  return ARM_ORDER.map((name) => {
    const key = name.replace(/-/g, '_');
    const got = r[`arm_${key}_rc`];
    return { name, want: Number(r[`arm_${key}_want`] ?? (name.endsWith('planted') ? 1 : 0)), got: got === undefined || got === '' ? null : Number(got) };
  });
}

export const HOSTED = 'brightwater-1';

/** The reasons the drill fails, in order; an empty list is a PASS. */
export function failures(r: Results): string[] {
  const out: string[] = [];
  if (r.failed_step) out.push(`step ${r.failed_step} failed`);
  for (const a of arms(r)) {
    if (a.got === null) out.push(`arm ${a.name} did not run`);
    else if (a.got !== a.want) out.push(`arm ${a.name} exited ${a.got}, required ${a.want}`);
  }
  if (r.bucket_equal !== 'yes') out.push(r.bucket_equal === 'no' ? 'the bucket listing changed during the drill' : 'the bucket listing was not compared');
  if (r.instances_before !== HOSTED) out.push(`the instances before were not the hosted server only (${r.instances_before ?? 'not read'})`);
  if (r.instances_after !== HOSTED) out.push(`the instances after are not the hosted server only (${r.instances_after ?? 'not read'})`);
  if (r.drill_keys_after !== '0') out.push(`drill key pairs left after the teardown: ${r.drill_keys_after ?? 'not read'}`);
  if (r.teardown !== 'ok') out.push('the teardown did not finish');
  return out;
}

/** True when the listing of that side read 0 objects (a count that was read, not a missing one). */
const emptyBucket = (count: string | undefined): boolean => count !== undefined && count !== '' && Number(count) === 0;

/** F-1584: what the record flags beside the verdict; an empty list flags nothing. A flag never changes the verdict. */
export function flags(r: Results): string[] {
  const out: string[] = [];
  const before = emptyBucket(r.bucket_before_count);
  const after = emptyBucket(r.bucket_after_count);
  if (before || after) {
    const side = before && after ? 'before and after the drill' : before ? 'before the drill' : 'after the drill';
    out.push(`the hosted bucket held 0 objects ${side}: no hosted backup set is there. Before P8-UNLOCK that is expected (the hosted backup timers stay off, owner ruling 1c7bcc42, F-388); after P8-UNLOCK it means hosted backups are not landing, a failure to diagnose (F-1584)`);
  }
  return out;
}

const ZONE = 'America/New_York';
export function localTime(epoch: number, withDate = true): string {
  const d = new Date(epoch * 1000);
  const opts: Intl.DateTimeFormatOptions = { timeZone: ZONE, hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short' };
  if (withDate) Object.assign(opts, { month: 'short', day: 'numeric', year: 'numeric' });
  return new Intl.DateTimeFormat('en-US', opts).format(d).replace(/ /g, ' ');
}
/** A backup set stamp (20261114T114700Z, UTC) in the owner's zone. */
export function stampTime(stamp: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(stamp);
  if (!m) return stamp;
  const [, y, mo, d, h, mi, s] = m.map(Number) as number[];
  return localTime(Date.UTC(y!, mo! - 1, d!, h!, mi!, s!) / 1000);
}
/** The bucket compare in words: equal, unequal, or not compared (a listing failed or never ran). */
export const bucketWord = (r: Results): string => (r.bucket_equal === 'yes' ? 'equal' : r.bucket_equal === 'no' ? 'unequal' : 'not compared');
const mins = (s: string | undefined): string => (s === undefined || s === '' ? 'not measured' : `${(Number(s) / 60).toFixed(1)} min`);

export function render(r: Results): string {
  const fails = failures(r);
  const dry = r.mode !== 'run';
  const verdict = fails.length === 0 ? 'PASS' : 'FAIL';
  const start = Number(r.started_epoch);
  const end = Number(r.ended_epoch);
  const set = r.set_stamp ? `set ${r.set_stamp} (taken ${stampTime(r.set_stamp)})` : 'no set taken';
  const lines: string[] = [];
  lines.push('# P8-RESTORE-DRILL: record (the pre-release restore drill)');
  lines.push('');
  if (dry) lines.push('DRY RUN: canned answers, no AWS call and no server; this file is a rehearsal of the record, never the record.', '');
  const why = fails.length === 0
    ? `the sample world of a fresh setup on temporary copy 1 was backed up by infra/backup/backup.sh, restored on temporary copy 2 by the operator procedure (SPECIFICATIONS 11.7), equals its manifest table by table, and passes the smoke sign-in; both known-bad arms failed as required; the hosted bucket's listing is unchanged${emptyBucket(r.bucket_before_count) ? ` and empty (0 objects before and ${r.bucket_after_count ?? '?'} after)` : ''} and only ${HOSTED} remains.`
    : fails.join('; ') + '.';
  lines.push(`Verdict: ${verdict} - ${why}`);
  for (const f of flags(r)) lines.push(`Flagged: ${f}.`);
  lines.push(`Measured: ${r.tables ?? '?'} tables and ${r.rows ?? '?'} rows restored equal to the manifest of ${set}, dump ${r.dump_bytes ?? '?'} bytes, pg_restore ${r.restore_seconds ?? '?'} s; smoke sign-in exit ${r.arm_smoke_rc ?? 'not run'}; bucket ${r.bucket_before_count ?? '?'} objects before and ${r.bucket_after_count ?? '?'} after (${bucketWord(r)}); plan ${r.plan ?? '?'}, image ${r.image ?? '?'}.`);
  lines.push('');
  lines.push(`Date measured: ${Number.isFinite(start) ? localTime(start) : '?'} to ${Number.isFinite(end) ? localTime(end, false) : '?'}${Number.isFinite(start) && Number.isFinite(end) ? ` (${mins(String(end - start))})` : ''}; commit ${r.commit ?? '?'}.`);
  lines.push('');
  lines.push('Owner ruling 7b6bf018 (Nov 2, 2026): load the sample world on a temporary server, back it up with the real script, restore it on a second one; it touches nothing hosted. The hosted server and its bucket were only listed (Lightsail get-instances and get-key-pairs from this Mac; the bucket on the hosted server, owner answer 1921a7c5 of Nov 14, 2026: "Read it on the server"), through the drill guard (infra/drill/guard.sh), which refuses every other call on them.');
  lines.push('');
  lines.push('## Arms');
  lines.push('');
  lines.push('| Arm | Required exit | Measured exit | Result |');
  lines.push('| --- | --- | --- | --- |');
  for (const a of arms(r)) {
    lines.push(`| ${ARM_WORDS[a.name]} | ${a.want} | ${a.got ?? 'not run'} | ${a.got === a.want ? 'as required' : 'FAIL'} |`);
  }
  if (r.smoke_row) lines.push('', `Smoke row found: ${r.smoke_row}`);
  lines.push('');
  lines.push('## Stages');
  lines.push('');
  lines.push(`1. Preflight (the instance list, the key pairs and the bucket listing read; the image ${r.image ?? '?'}): ${mins(r.t_preflight)}.`);
  lines.push(`2. Temporary copy 1: created, Docker installed, the release deployed, a fresh setup of the sample world: ${mins(r.t_copy1)}.`);
  lines.push(`3. Backup on copy 1 (backup.sh, target local on the copy), the restore test's known-bad then the restore test, the set fetched and its SHA-256 checked on this Mac: ${mins(r.t_backup)}.`);
  lines.push(`4. Temporary copy 2: created, Docker installed, the release deployed: ${mins(r.t_copy2)}.`);
  lines.push(`5. Restore on copy 2 (web, worker and pbs stopped; restore-copy.sh restore; the planted check; the stack started${r.healthz2_seconds ? `, healthz 200 after ${r.healthz2_seconds} s and ${r.healthz2_tries ?? '?'} ${r.healthz2_tries === '1' ? 'try' : 'tries'}` : ''}; the smoke sign-in): ${mins(r.t_restore)}.`);
  lines.push(`6. Teardown (both copies and their key pairs deleted; the instance list, the key pairs and the bucket listing read again): ${mins(r.t_teardown)}.`);
  lines.push('');
  lines.push('## Hosted, read only');
  lines.push('');
  lines.push(`- Instances before: ${r.instances_before ?? 'not read'}; after: ${r.instances_after ?? 'not read'} (plan of ${HOSTED}: ${r.hosted_plan ?? '?'}).`);
  lines.push(`- Drill key pairs left after: ${r.drill_keys_after ?? 'not read'}.`);
  lines.push(`- Bucket listing (key, size, ETag, last modified; sorted): ${bucketWord(r)}${emptyBucket(r.bucket_before_count) || emptyBucket(r.bucket_after_count) ? ', EMPTY (flagged above)' : ''}; ${r.bucket_before_count ?? '?'} objects before, SHA-256 ${r.bucket_before_sha ?? '?'}; ${r.bucket_after_count ?? '?'} after, SHA-256 ${r.bucket_after_sha ?? '?'}. Read on the hosted server over deploy.sh's ssh target by 1 fixed READ-ONLY command (aws s3api list-objects-v2, the server's own resource access, as its backup job reaches the bucket): no get, put or delete, no file written there, no key passed or recorded. Before: in the preflight, before any copy existed; after: in the teardown, after both were deleted.`);
  lines.push('');
  lines.push('## Notes');
  lines.push('');
  lines.push('- The set is taken to a folder on copy 1 (backup.sh with BACKUP_TARGET=local), not to the hosted bucket: the ruling says the drill touches nothing hosted, so the step "fetch the chosen dump from the bucket" is a copy from copy 1 to copy 2 through this Mac, the dump\'s SHA-256 checked against its manifest on the way.');
  lines.push('- The restore test runs on copy 1 only: the set is taken before backup.sh writes its own backup_record row, so a restored copy has no record of the set, and the test\'s record check would fail on copy 2 by design.');
  lines.push('- checksums.sql (the manifest\'s checksum) covers every column of every row, in primary key order (F-1579), so a changed value outside a key fails the compare as a changed key does. The manifest names that method (checksum_method full-row-v2, F-1582); every checker computes the restored side by the method its manifest names, reads a manifest with none as the key-only method of the sets made before F-1579, and refuses a method it does not know.');
  lines.push(`- Evidence: ${r.evidence_dir ? r.evidence_dir.replace(/\/?$/, '/') : 'the evidence folder the drill wrote'} (the results file, the guard's call log with every address replaced, the arms' event lines). The copies are named "temporary copy 1" and "temporary copy 2" here; no address is recorded.`);
  return lines.join('\n') + '\n';
}

if (isMain(import.meta.url)) {
  const [path] = process.argv.slice(2);
  if (!path) throw new Error('usage: record.ts <results.env>');
  process.stdout.write(render(parseResults(readFileSync(path, 'utf8'))));
}
