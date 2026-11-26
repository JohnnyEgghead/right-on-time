// SPDX-License-Identifier: AGPL-3.0-or-later
// import-target-counts (P2-IMPORT; REQUIREMENTS FR-IMP-6, FR-IMP-3; SPECIFICATIONS section 6.7 "Target counts"):
// the instrument. It reads the target table from REQUIREMENTS.md itself (the counts come from the import mockup and
// STORY.md, not from the generator, so they check it independently), and checks 3 properties of a run's report:
//   counts   "the report equals every number of the FR-IMP-6 table" (811 exact matches, or any other count, fails)
//   pairs    "the exact and likely pair sets equal the committed planted-truth file" (record A and B by customer_ref)
//   truth    "the truth file's own counts equal the table"
// A table it cannot read is TableError (the gate exits 2: it cannot judge), never a pass.

const PROBLEM_PHRASES = {
  'visit with no customer': 'visit_no_customer',
  'missing ZIP code': 'missing_zip',
  'bad phone number': 'bad_phone',
  'visit date not readable': 'visit_date_unreadable',
  'equipment with no address': 'equipment_no_address',
  'customer name blank': 'customer_name_blank',
} as const;
export type Reason = (typeof PROBLEM_PHRASES)[keyof typeof PROBLEM_PHRASES];

/** What happens to a row of each reason, as the import does it (model.ts): customers' problems are flagged. */
const TREATMENT: Record<Reason, 'flagged' | 'not imported'> = {
  visit_no_customer: 'not imported', missing_zip: 'flagged', bad_phone: 'flagged',
  visit_date_unreadable: 'not imported', equipment_no_address: 'not imported', customer_name_blank: 'flagged',
};

export interface Targets {
  customers: { total: number; clean: number; flagged: number };
  visits: { total: number; imported: number; notImported: number };
  equipment: { total: number; imported: number; notImported: number };
  problems: { total: number; byReason: Record<Reason, number> };
  duplicates: { total: number; exact: number; likely: number };
}

export interface ReportLike extends Targets {
  pairs: { exact: { a: string; b: string }[]; likely: { a: string; b: string }[] };
}

export interface TruthLike {
  counts: { exact: number; likely: number };
  exact: { a: string; b: string }[];
  likely: { a: string; b: string }[];
}

export class TableError extends Error {
  constructor(what: string) {
    super(`import-target-counts: the FR-IMP-6 table cannot be read: ${what}`);
    this.name = 'TableError';
  }
}

const num = (s: string) => Number(s.replace(/,/g, ''));
const N = '(\\d{1,3}(?:,\\d{3})*|\\d+)';

function row(lines: string[], label: RegExp, what: string): string {
  const hit = lines.filter((l) => label.test(l));
  if (hit.length !== 1) throw new TableError(`${hit.length} rows for ${what}`);
  const cells = (hit[0] as string).split('|').map((c) => c.trim());
  const value = cells[2];
  if (cells.length !== 4 || !value) throw new TableError(`the ${what} row is not "| item | target |"`);
  return value;
}

function match(value: string, re: RegExp, what: string): string[] {
  const m = re.exec(value);
  if (!m) throw new TableError(`the ${what} target "${value}" is not in the expected words`);
  return m.slice(1);
}

/** Read the import target table that follows "**Import target counts (FR-IMP-6).**" in REQUIREMENTS.md. */
export function parseTargets(requirements: string): Targets {
  const start = requirements.indexOf('**Import target counts (FR-IMP-6).**');
  if (start < 0) throw new TableError('no "Import target counts (FR-IMP-6)" heading');
  const block = requirements.slice(start).split('\n');
  const end = block.findIndex((l, i) => i > 2 && l.startsWith('#'));
  const lines = block.slice(0, end < 0 ? undefined : end).filter((l) => l.startsWith('|'));

  const [ct, cc, cf] = match(row(lines, /^\| Customers \|/, 'Customers'), new RegExp(`^${N}: ${N} clean, ${N} imported and flagged$`), 'Customers').map(num);
  const [vt, vi, vn] = match(row(lines, /^\| Service visits\b/, 'Service visits'), new RegExp(`^${N}: ${N} imported, ${N} not imported$`), 'Service visits').map(num);
  const [et, ei, en] = match(row(lines, /^\| Equipment \|/, 'Equipment'), new RegExp(`^${N}: ${N} imported, ${N} not imported$`), 'Equipment').map(num);
  const problemsCell = row(lines, /^\| Problem rows \|/, 'Problem rows');
  const [pt, list] = match(problemsCell, new RegExp(`^${N}: (.+)$`), 'Problem rows');
  const byReason = {} as Record<Reason, number>;
  for (const part of (list as string).split(';').map((s) => s.trim())) {
    const [phrase, count, treatment] = match(part, new RegExp(`^(.+?) ${N} \\((flagged|not imported)\\)$`), 'problem reason');
    const reason = PROBLEM_PHRASES[phrase as keyof typeof PROBLEM_PHRASES];
    if (!reason) throw new TableError(`unknown problem reason "${phrase}"`);
    if (reason in byReason) throw new TableError(`problem reason "${phrase}" is listed twice`);
    if (TREATMENT[reason] !== treatment) throw new TableError(`"${phrase}" is ${treatment} in the table, ${TREATMENT[reason]} in the import`);
    byReason[reason] = num(count as string);
  }
  if (Object.keys(byReason).length !== Object.keys(PROBLEM_PHRASES).length) throw new TableError('the table does not list all 6 problem reasons');
  const [dt, dx, dl] = match(row(lines, /^\| Likely duplicates \|/, 'Likely duplicates'), new RegExp(`^${N}: ${N} exact, merged; ${N} listed for the office$`), 'Likely duplicates').map(num);

  const t: Targets = {
    customers: { total: ct as number, clean: cc as number, flagged: cf as number },
    visits: { total: vt as number, imported: vi as number, notImported: vn as number },
    equipment: { total: et as number, imported: ei as number, notImported: en as number },
    problems: { total: num(pt as string), byReason },
    duplicates: { total: dt as number, exact: dx as number, likely: dl as number },
  };
  const sum = (o: Record<string, number>) => Object.values(o).reduce((x, y) => x + y, 0);
  const consistent = t.customers.clean + t.customers.flagged === t.customers.total
    && t.visits.imported + t.visits.notImported === t.visits.total
    && t.equipment.imported + t.equipment.notImported === t.equipment.total
    && sum(byReason) === t.problems.total
    && t.duplicates.exact + t.duplicates.likely === t.duplicates.total;
  if (!consistent) throw new TableError('its parts do not add up to its totals');
  return t;
}

const pairKey = (p: { a: string; b: string }) => `${p.a}>${p.b}`;

function setDiff(kind: string, got: { a: string; b: string }[], want: { a: string; b: string }[]): string[] {
  const g = new Set(got.map(pairKey));
  const w = new Set(want.map(pairKey));
  const out: string[] = [];
  if (g.size !== got.length) out.push(`${kind}: the report repeats a pair`);
  const extra = [...g].filter((k) => !w.has(k));
  const missing = [...w].filter((k) => !g.has(k));
  if (extra.length) out.push(`${kind}: ${extra.length} found but not in the truth file (record A>B), e.g. ${extra.slice(0, 3).join(', ')}`);
  if (missing.length) out.push(`${kind}: ${missing.length} in the truth file but not found (record A>B), e.g. ${missing.slice(0, 3).join(', ')}`);
  return out;
}

/** Every failed property, each line naming it; empty when the report passes. */
export function checkTargets(report: ReportLike, truth: TruthLike, targets: Targets): string[] {
  const out: string[] = [];
  const flat = (o: Targets): Record<string, number> => ({
    'customers.total': o.customers.total, 'customers.clean': o.customers.clean, 'customers.flagged': o.customers.flagged,
    'visits.total': o.visits.total, 'visits.imported': o.visits.imported, 'visits.notImported': o.visits.notImported,
    'equipment.total': o.equipment.total, 'equipment.imported': o.equipment.imported, 'equipment.notImported': o.equipment.notImported,
    'problems.total': o.problems.total,
    ...Object.fromEntries(Object.entries(o.problems.byReason).map(([k, v]) => [`problems.${k}`, v])),
    'duplicates.total': o.duplicates.total, 'duplicates.exact': o.duplicates.exact, 'duplicates.likely': o.duplicates.likely,
  });
  const want = flat(targets);
  const got = flat(report);
  for (const [k, v] of Object.entries(want)) {
    if (got[k] !== v) out.push(`counts (the report equals every number of the FR-IMP-6 table): ${k} is ${got[k]}, the table says ${v}`);
  }
  if (report.pairs.exact.length !== report.duplicates.exact || report.pairs.likely.length !== report.duplicates.likely) {
    out.push('counts (the report equals every number of the FR-IMP-6 table): the report\'s pair lists disagree with its own counts');
  }
  for (const f of [...setDiff('exact', report.pairs.exact, truth.exact), ...setDiff('likely', report.pairs.likely, truth.likely)]) {
    out.push(`pairs (the exact and likely pair sets equal the committed planted-truth file): ${f}`);
  }
  if (truth.counts.exact !== targets.duplicates.exact || truth.exact.length !== targets.duplicates.exact
    || truth.counts.likely !== targets.duplicates.likely || truth.likely.length !== targets.duplicates.likely) {
    out.push(`truth (the truth file's own counts equal the table): it holds ${truth.exact.length} exact and ${truth.likely.length} likely pairs `
      + `(counts ${truth.counts.exact} and ${truth.counts.likely}), the table says ${targets.duplicates.exact} and ${targets.duplicates.likely}`);
  }
  return out;
}
