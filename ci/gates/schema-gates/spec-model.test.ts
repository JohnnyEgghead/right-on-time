// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: SD-40 (schema-doc-parity reads its expected schema from SPECIFICATIONS section 3; this pins how)
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { expectedForeignKeys, parseSpec, SpecParseError } from './spec-model.ts';

// F-1852: docs/SPECIFICATIONS.md is a private path (scripts/private-paths.txt), so in a public copy the tests on the real document
// skip with a note naming it; the private checkout has it and they run. The planted-row tests below need no file.
const DOC = path.resolve(import.meta.dirname, '..', '..', '..', 'docs', 'SPECIFICATIONS.md');
const noDoc = existsSync(DOC) ? '' : 'docs/SPECIFICATIONS.md is not in this copy (a private path the public export leaves out)';
const spec = noDoc ? (undefined as unknown as ReturnType<typeof parseSpec>) : parseSpec(readFileSync(DOC, 'utf8'));
const col = (t: string, c: string) => spec.tables.get(t)?.columns.get(c);

/** A minimal section 3 for the parser's error cases. */
const mini = (rows: string, heading = '#### `thing` (store: world)') =>
  `## 3. Canonical Data Model\n\n${heading}\n\n| Field | Type | Notes |\n|---|---|---|\n${rows}\n\n## 4. Next\n`;

describe('parseSpec on the real SPECIFICATIONS', () => {
  it('reads every entity table of section 3, its schemas and its view', (ctx) => {
    if (noDoc) ctx.skip(noDoc);
    expect(spec.tables.size).toBe(62);
    expect(spec.schemas).toEqual(['pbs', 'pbs_snapshot', 'system', 'world', 'world_snapshot']);
    expect(spec.views).toEqual(['world.report_visit']);
    expect([...spec.tables.keys()].filter((k) => k.startsWith('pbs.')).sort()).toEqual(['pbs.call', 'pbs.invoice', 'pbs.invoice_line', 'pbs.mode']);
  });

  it('reads types, null and unique per column, pairing multi-name rows with their types', (ctx) => {
    if (noDoc) ctx.skip(noDoc);
    expect(col('world.job', 'technician_id')).toMatchObject({ type: 'uuid', nullable: true }); // null is Unassigned: a job holds at most 1 technician (invariant 3)
    expect(col('world.job', 'version')).toMatchObject({ type: 'integer', nullable: false }); // D15
    expect(col('world.equipment', 'year')).toMatchObject({ type: 'integer', nullable: true });
    expect(col('world.equipment', 'details')).toMatchObject({ type: 'text', nullable: true });
    expect(col('world.user', 'email')).toMatchObject({ type: 'citext', unique: true });
    expect(col('world.user', 'employee_number')).toMatchObject({ type: 'text', nullable: true, unique: true });
    expect(col('world.technician', 'skills')?.type).toBe('text[]');
    expect(col('world.customer', 'customer_since')?.zoneNote).toBe('branch');
    // A row that sets the current table carries it to the unqualified rows below (user, then user_change).
    expect(col('world.user', 'password_hash')).toMatchObject({ type: 'text', nullable: true });
    expect(col('world.user_change', 'by')).toMatchObject({ type: 'uuid', nullable: true });
  });

  it('reads each primary-key phrasing as the document means it', (ctx) => {
    if (noDoc) ctx.skip(noDoc);
    const pk = (t: string) => spec.tables.get(t)?.primaryKey;
    expect(pk('world.tech_item')).toEqual(['key']); // the same key gets the stored answer again (invariant 1)
    expect(pk('pbs.invoice')).toEqual(['job_number']); // invariant 10, "Primary key: 1 invoice per job ever"
    expect(pk('system.session')).toEqual(['token_hash']); // "Primary key: SHA-256 of the token" names the first column only
    expect(pk('world.job_part')).toEqual(['job_number', 'part_id']); // "Primary key (job_number, part_id)"
    expect(pk('world.membership')).toEqual(['customer_id']); // the parenthesis in "Primary key (FR-DISP-32)" cites a requirement; it is not a column list
    expect(pk('world.text_attempt')).toEqual(['text_id', 'number']); // "Primary key pair"
    expect(pk('world.import_problem_row')).toEqual(['run_id', 'file', 'row_number']);
    expect(pk('world.street')).toEqual(['id']); // an id column and no key note
    expect(pk('world.text_simulator')).toEqual([]); // 1 row, no key stated
  });

  it('derives the foreign keys of "Nullability and keys", none from the 5 cross-store columns', (ctx) => {
    if (noDoc) ctx.skip(noDoc);
    const fk = expectedForeignKeys(spec);
    expect(fk.get('world.job.customer_id')).toBe('world.customer.id'); // a job's customer must exist before the job: setup order depends on this foreign key (OI-57)
    expect(fk.get('world.job.service_id')).toBe('world.service_type.id'); // explicit note
    expect(fk.get('world.alert_email_link.email_link_hash')).toBe('world.email_link.token_hash'); // explicit note
    expect(fk.get('world.note.item_key')).toBe('world.tech_item.key');
    expect(fk.get('world.time_off.created_by')).toBe('world.user.id');
    expect(fk.get('pbs.invoice_line.job_number')).toBe('pbs.invoice.job_number');
    for (const c of ['system.session.user_id', 'pbs.invoice.job_number', 'pbs.invoice.entered_by', 'pbs.call.job_number', 'pbs.mode.set_by']) {
      expect(fk.has(c), c).toBe(false);
    }
    expect(fk.has('world.import_problem_row.flagged_entity_id')).toBe(false);
    expect(fk.has('world.job.job_number')).toBe(false);
  });
});

describe('parseSpec is strict: an unreadable row fails, never drops out', () => {
  it('fails an unknown type', () => {
    expect(() => parseSpec(mini('| `id` | `uuidd` | x |'))).toThrow(/unknown type `uuidd`/);
  });

  it('fails a row whose names and types do not pair', () => {
    expect(() => parseSpec(mini('| `a`, `b`, `c` | `text`, `uuid` | x |'))).toThrow(/3 names but 2 types/);
  });

  it('fails stray text in a Type cell', () => {
    expect(() => parseSpec(mini('| `a` | `text` maybe | x |'))).toThrow(/unreadable text in the Type cell/);
  });

  it('fails a heading with no Field table under it', () => {
    expect(() => parseSpec('## 3. X\n\n#### `thing` (store: world)\n\nprose\n\n## 4. Y\n')).toThrow(/no "\| Field \| Type \| Notes \|" table/);
  });

  it('fails an unqualified column in a heading of 2 tables, and a column defined twice', () => {
    expect(() => parseSpec(mini('| `a` | `text` | x |', '#### `one`, `two` (store: world)'))).toThrow(/has no table/);
    expect(() => parseSpec(mini('| `a` | `text` | x |\n| `a` | `text` | y |'))).toThrow(/defined twice/);
  });

  it('fails a reference column no rule resolves', () => {
    expect(() => expectedForeignKeys(parseSpec(mini('| `id` | `uuid` | x |\n| `gizmo_id` | `uuid` | x |')))).toThrow(SpecParseError);
  });
});
