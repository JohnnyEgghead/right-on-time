// SPDX-License-Identifier: AGPL-3.0-or-later
// G-IPHONE-WEB (BUILD_PLAN G-IPHONE-WEB Acceptance; FR-TECH-4, UC-03, NFR-09): the server-side check of the scripted iPhone run. It reads
// the 1 line of JSON infra/deploy/staging/ledger.sql prints (the server's ledger rows on Harold Jenkins's Sep 15 job) on stdin, prints
// 1 "ledger line" per row and a verdict per item, and exits 0 only when every item of the run reached the server exactly once:
//   On my way, Arrived, the note, the photo and Finish job: each exactly 1 ledger row (1 key), answered applied;
//   the note: exactly 1 world.note row under its key, judged entered offline by the server (FR-DEMO-9: it waited over 60 s on the phone);
//   the photo: exactly 1 world.photo row under its key.
// 0 rows of a kind is LOST (a lost note fails the gate); 2 or more is ARRIVED N TIMES (2 keys for 1 entry). A signature is optional on
// Finish job (FR-TECH-14): 0 or 1 is fine, and 1 must be applied. Any other kind (No one home) is not in the script and fails.
//   node infra/deploy/staging/ledger-check.ts < ledger.json      exit 0 PASS, 1 FAIL, 2 the input is not the ledger's JSON
// infra/deploy/staging.sh check runs it against the staging copy; infra/tests/ledger-check.test.ts proves it.
import { readFileSync } from 'node:fs';
import { isMain } from '../../../ci/is-main.ts';

export interface LedgerItem {
  key: string;
  kind: string;
  jobNumber: number;
  result: string;
  technician: string | null;
  deviceTimeReal: string;
  receivedAtDemo: string;
  noteRows: number;
  noteOffline: boolean | null;
  noteText: string | null;
  photoRows: number;
  photoBytes: number | null;
}

export interface Ledger {
  jobs: number[];
  items: LedgerItem[];
}

export interface Verdict {
  pass: boolean;
  lines: string[];
  failures: string[];
}

/** The items the script makes, in its order, each exactly once. */
export const REQUIRED = ['on_my_way', 'arrived', 'note', 'photo', 'finished'] as const;
/** The words the owner types for the note (docs/build/spikes/G-IPHONE-WEB.md step 9): a note under the key with other words is not the script's note (F-1051). */
export const NOTE_TEXT = 'Basement test note';
/** The technician the script signs in as: any other sender fails the item. */
export const TECHNICIAN = 'Maria Santos';
/** Kinds the script allows but does not ask for. */
const OPTIONAL = ['signature'] as const;

const LABEL: Record<string, string> = {
  on_my_way: 'On my way', arrived: 'Arrived', note: 'the note', photo: 'the photo', finished: 'Finish job', signature: 'the signature',
  no_one_home: 'No one home',
};

/** Parse the ledger's JSON; throws on anything else (the CLI answers it exit 2). */
export function parseLedger(text: string): Ledger {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{'));
  if (lines.length !== 1) throw new Error(`expected 1 line of ledger JSON, got ${lines.length}`);
  const v = JSON.parse(lines[0] as string) as Partial<Ledger>;
  if (!Array.isArray(v.jobs) || !Array.isArray(v.items)) throw new Error('the JSON has no jobs and items arrays');
  return { jobs: v.jobs, items: v.items };
}

export function ledgerLine(i: LedgerItem): string {
  const extra = i.kind === 'note' ? ` note rows ${i.noteRows}, entered offline ${i.noteOffline === true ? 'yes' : 'no'}, text "${i.noteText ?? ''}"`
    : i.kind === 'photo' ? ` photo rows ${i.photoRows}, ${i.photoBytes ?? 0} bytes` : '';
  return `ledger line: ${i.key} ${i.kind} job ${i.jobNumber} ${i.result} by ${i.technician ?? 'unknown'}, phone time ${i.deviceTimeReal}, received (demo) ${i.receivedAtDemo};${extra}`;
}

/** Judge 1 snapshot of the ledger (pure). */
export function judge(ledger: Ledger): Verdict {
  const lines: string[] = [];
  const failures: string[] = [];
  if (ledger.jobs.length !== 1) {
    failures.push(`Harold Jenkins's Sep 15 job with Maria Santos: found ${ledger.jobs.length} jobs, want 1 (is this the staging world?)`);
    return { pass: false, lines, failures };
  }
  const job = ledger.jobs[0] as number;
  lines.push(`job ${job} (Harold Jenkins, Tue Sep 15, Maria Santos): ${ledger.items.length} ledger rows`);
  for (const i of ledger.items) lines.push(ledgerLine(i));
  const byKind = new Map<string, LedgerItem[]>();
  for (const i of ledger.items) byKind.set(i.kind, [...(byKind.get(i.kind) ?? []), i]);

  for (const kind of [...REQUIRED, ...OPTIONAL]) {
    const rows = byKind.get(kind) ?? [];
    const label = LABEL[kind] ?? kind;
    const optional = (OPTIONAL as readonly string[]).includes(kind);
    if (rows.length === 0) {
      if (optional) { lines.push(`${label}: none (optional)`); continue; }
      failures.push(`${label}: LOST (no ledger row)`);
      continue;
    }
    if (rows.length > 1) {
      failures.push(`${label}: ARRIVED ${rows.length} TIMES (${rows.length} keys: ${rows.map((r) => r.key).join(', ')})`);
      continue;
    }
    const r = rows[0] as LedgerItem;
    const bad: string[] = [];
    if (r.result !== 'applied') bad.push(`answered ${r.result}, not applied`);
    if (r.technician !== TECHNICIAN) bad.push(`sent by ${r.technician ?? 'unknown'}, not ${TECHNICIAN}`);
    if (kind === 'note') {
      if (r.noteRows !== 1) bad.push(r.noteRows === 0 ? 'LOST: no note row under its key' : `${r.noteRows} note rows under its key`);
      else if (r.noteOffline !== true) bad.push('the server did not judge it entered offline (it reached the server within 60 s of entry)');
      if (r.noteRows === 1 && r.noteText !== NOTE_TEXT) bad.push(`the note text is "${r.noteText ?? ''}", not "${NOTE_TEXT}"`);
    }
    if (kind === 'photo' && r.photoRows !== 1) bad.push(r.photoRows === 0 ? 'LOST: no photo row under its key' : `${r.photoRows} photo rows under its key`);
    if (bad.length) failures.push(`${label}: ${bad.join('; ')}`);
    else lines.push(`${label}: once (${r.key}, applied)`);
  }
  for (const [kind, rows] of byKind) {
    if (!(REQUIRED as readonly string[]).includes(kind) && !(OPTIONAL as readonly string[]).includes(kind)) {
      failures.push(`${LABEL[kind] ?? kind}: ${rows.length} ledger rows, and the script has no such step`);
    }
  }
  return { pass: failures.length === 0, lines, failures };
}

export function report(v: Verdict): string {
  return [...v.lines, ...v.failures.map((f) => `FAIL ${f}`), `LEDGER CHECK ${v.pass ? 'PASS' : 'FAIL'}`].join('\n');
}

if (isMain(import.meta.url)) {
  let ledger: Ledger;
  try {
    ledger = parseLedger(readFileSync(0, 'utf8'));
  } catch (e) {
    process.stderr.write(`ledger-check: ${(e as Error).message}\n`);
    process.exit(2);
  }
  const v = judge(ledger);
  process.stdout.write(`${report(v)}\n`);
  process.exit(v.pass ? 0 : 1);
}
