// SPDX-License-Identifier: AGPL-3.0-or-later
// Invoice composition (SPECIFICATIONS SD-20, section 6.6 FR-BILL-13; OA-71, OA-74, OA-78) and the wire shape the billing
// link sends to the pretend billing service (section 4.5). Pure: the billing link reads the job's service, parts,
// labor, work-done lines and membership in its own transaction and passes them here; pbs validates what it receives
// with validateInvoice before it stores it.
//
// Line order (SD-20): the service line at its invoice price; 1 line per part at list price times quantity; the labor
// line with the hours worked at $0.00 (OA-74: the service price covers the visit's labor); the work-done lines with no
// amount; and, for a Comfort Club member, the discount line at minus 15% of the service line, rounded half-up to the
// cent ($0.00 on a $0.00 service). Total = service + parts - discount.

export const INVOICE_LINE_KINDS = ['service', 'part', 'labor', 'work_done', 'discount'] as const;
export type InvoiceLineKind = (typeof INVOICE_LINE_KINDS)[number];

export interface InvoiceLine {
  kind: InvoiceLineKind;
  label: string;
  /** The part code; null on every other line. */
  code: string | null;
  quantity: number | null;
  unitCents: number | null;
  /** Null on work-done lines only. */
  amountCents: number | null;
}

/** What the billing link sends with POST /invoices (section 4.5 InvoiceRequest). */
export interface InvoiceRequest {
  jobNumber: number;
  customerName: string;
  /** The job's finish time (job.ended_at), RFC 3339. */
  doneAt: string;
  /**
   * The demo time of this send, RFC 3339. pbs stamps its call and invoice rows with it: role pbs reads nothing in
   * `system`, so it has no demo clock of its own (section 3 grants; FR-BILL-4).
   */
  sentAt: string;
  lines: InvoiceLine[];
  totalCents: number;
}

/** The Comfort Club member rate, in percent of the service line only (SD-20; FR-DISP-32's "15% off repairs"). */
export const MEMBER_RATE_PERCENT = 15;

/** The service line labels of the invoice table (SD-20), by the seeded service id (packages/db seed reference data). */
export const SERVICE_INVOICE_LABELS: Readonly<Record<string, string>> = {
  furnace_tune_up: 'Furnace tune-up',
  ac_tune_up: 'AC tune-up',
  heating_or_ac_fix: 'Heating or AC fix',
  plumbing_repair: 'Plumbing repair',
  water_heater: 'Water heater',
  thermostat: 'Thermostat',
  boiler_repair: 'Boiler repair',
  tankless_heater_flush: 'Tankless heater flush',
  sump_pump_install: 'Sump pump install',
};

export const DISCOUNT_LABEL = `Comfort Club discount, ${MEMBER_RATE_PERCENT}% off the service line`;

export interface InvoiceSource {
  jobNumber: number;
  customerName: string;
  doneAt: string;
  serviceId: string;
  /** service_type.invoice_price_cents (0 where no dollar amount is shown, OI-24). */
  servicePriceCents: number;
  /** The job's job_part rows joined to part, in the order the billing link read them. */
  parts: readonly { code: string; name: string; priceCents: number; quantity: number }[];
  laborMinutes: number;
  /** work_done_line texts in seq order (technician finish only, OI-35). */
  workDone: readonly string[];
  member: boolean;
}

export type ComposeResult =
  | { ok: true; lines: InvoiceLine[]; totalCents: number }
  | { ok: false; reason: string };

/** Half-up rounding of a non-negative amount in hundredths of a cent to whole cents. */
const percentOf = (cents: number, percent: number): number => Math.floor((cents * percent + 50) / 100);

/** "Hours worked: 2 hr 9 min" (the invoice mockup's labor line, mockups/pages/r1-pbs-a-invoice.html). */
export function laborLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const parts = [h > 0 ? `${h} hr` : '', m > 0 || h === 0 ? `${m} min` : ''].filter((x) => x !== '');
  return `Hours worked: ${parts.join(' ')}`;
}

const isCents = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n);

/**
 * What a line's label was composed from (SD-20): the service id, the labor minutes or the member rate. A reader says the line in its
 * own language from these facts (the Spanish pretend billing invoice, F-593) while pbs keeps the label as it received it.
 */
export type LineWords = { service: string } | { laborMinutes: number } | { ratePercent: number };

const LABOR = /^Hours worked: (?:(\d+) hr)?(?: ?(\d+) min)?$/;

/**
 * The facts a received line's label was composed from, or null: a part name or a work-done text (written by people, not composed), or a
 * label this composer would not write from any facts. The answer always composes back to the very label (a round trip), so a reader
 * that says it in another language says what billing received.
 */
export function lineWordsOf(line: { kind: string; label: string }): LineWords | null {
  if (line.kind === 'service') {
    const id = Object.keys(SERVICE_INVOICE_LABELS).find((k) => SERVICE_INVOICE_LABELS[k] === line.label);
    return id === undefined ? null : { service: id };
  }
  if (line.kind === 'labor') {
    const m = LABOR.exec(line.label);
    if (!m || (m[1] === undefined && m[2] === undefined)) return null;
    const minutes = Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0);
    return laborLabel(minutes) === line.label ? { laborMinutes: minutes } : null;
  }
  if (line.kind === 'discount') return line.label === DISCOUNT_LABEL ? { ratePercent: MEMBER_RATE_PERCENT } : null;
  return null;
}

/** Composes 1 invoice (SD-20) from its service, labor, parts, work-done lines and member rate. A source the link cannot bill (an unknown service, a bad price) is a data error. */
export function composeInvoice(src: InvoiceSource): ComposeResult {
  const label = SERVICE_INVOICE_LABELS[src.serviceId];
  if (label === undefined) return { ok: false, reason: `service ${src.serviceId} has no invoice line` };
  if (!isCents(src.servicePriceCents) || src.servicePriceCents < 0) return { ok: false, reason: 'the service price is not whole cents' };
  if (!Number.isInteger(src.laborMinutes) || src.laborMinutes < 0) return { ok: false, reason: 'the labor time is not whole minutes' };
  const lines: InvoiceLine[] = [
    { kind: 'service', label, code: null, quantity: 1, unitCents: src.servicePriceCents, amountCents: src.servicePriceCents },
  ];
  for (const p of src.parts) {
    if (!isCents(p.priceCents) || p.priceCents < 0 || !Number.isInteger(p.quantity) || p.quantity < 1) {
      return { ok: false, reason: `part ${p.code} has no whole price or quantity` };
    }
    lines.push({ kind: 'part', label: p.name, code: p.code, quantity: p.quantity, unitCents: p.priceCents, amountCents: p.priceCents * p.quantity });
  }
  lines.push({ kind: 'labor', label: laborLabel(src.laborMinutes), code: null, quantity: null, unitCents: 0, amountCents: 0 });
  for (const text of src.workDone) lines.push({ kind: 'work_done', label: text, code: null, quantity: null, unitCents: null, amountCents: null });
  if (src.member) {
    const off = percentOf(src.servicePriceCents, MEMBER_RATE_PERCENT);
    lines.push({ kind: 'discount', label: DISCOUNT_LABEL, code: null, quantity: null, unitCents: null, amountCents: off === 0 ? 0 : -off });
  }
  return { ok: true, lines, totalCents: invoiceTotal(lines) };
}

/** The sum of the priced lines (work-done lines carry no amount). */
export function invoiceTotal(lines: readonly InvoiceLine[]): number {
  return lines.reduce((sum, l) => sum + (l.amountCents ?? 0), 0);
}

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * pbs's check of a received invoice: the shape of section 4.5 and SD-20's arithmetic. Answers the data-error reason in
 * words, or null when the invoice can be stored. A malformed request is a data error, held for a person (FR-BILL-7).
 */
export function validateInvoice(body: unknown): { ok: true; invoice: InvoiceRequest } | { ok: false; reason: string } {
  const bad = (reason: string) => ({ ok: false as const, reason });
  if (typeof body !== 'object' || body === null) return bad('the invoice is not a JSON object');
  const b = body as Record<string, unknown>;
  if (!Number.isInteger(b.jobNumber) || (b.jobNumber as number) < 1) return bad('the job number is missing');
  if (typeof b.customerName !== 'string' || b.customerName.trim() === '') return bad('the customer name is missing');
  if (typeof b.doneAt !== 'string' || !RFC3339.test(b.doneAt)) return bad('the finish time is missing');
  if (typeof b.sentAt !== 'string' || !RFC3339.test(b.sentAt)) return bad('the send time is missing');
  if (!Array.isArray(b.lines) || b.lines.length === 0) return bad('the invoice has no lines');
  if (!isCents(b.totalCents)) return bad('the total is not whole cents');
  const lines: InvoiceLine[] = [];
  for (const raw of b.lines as unknown[]) {
    if (typeof raw !== 'object' || raw === null) return bad('a line is not an object');
    const l = raw as Record<string, unknown>;
    if (!(INVOICE_LINE_KINDS as readonly unknown[]).includes(l.kind)) return bad('a line has an unknown kind');
    if (typeof l.label !== 'string' || l.label === '') return bad('a line has no label');
    const nullableInt = (v: unknown) => v === null || isCents(v);
    if (!(l.code === null || typeof l.code === 'string') || !nullableInt(l.quantity) || !nullableInt(l.unitCents) || !nullableInt(l.amountCents)) {
      return bad('a line has a bad code, quantity or amount');
    }
    const line: InvoiceLine = {
      kind: l.kind as InvoiceLineKind, label: l.label, code: l.code as string | null, quantity: l.quantity as number | null,
      unitCents: l.unitCents as number | null, amountCents: l.amountCents as number | null,
    };
    if (line.kind === 'part') {
      if (line.code === null || line.quantity === null || line.quantity < 1 || line.unitCents === null || line.amountCents !== line.unitCents * line.quantity) {
        return bad(`part line ${line.label} does not equal its list price times its quantity`);
      }
    } else if (line.kind === 'work_done') {
      if (line.amountCents !== null) return bad('a work-done line carries an amount');
    } else if (line.amountCents === null) {
      return bad(`the ${line.kind} line has no amount`);
    }
    if (line.kind === 'discount' && (line.amountCents ?? 0) > 0) return bad('the discount line adds to the total');
    lines.push(line);
  }
  if (lines[0]?.kind !== 'service' || lines.filter((l) => l.kind === 'service').length !== 1) return bad('the invoice needs exactly 1 service line, first');
  if (invoiceTotal(lines) !== b.totalCents) return bad('the total does not equal the sum of the priced lines');
  return {
    ok: true,
    invoice: { jobNumber: b.jobNumber as number, customerName: b.customerName, doneAt: b.doneAt, sentAt: b.sentAt, lines, totalCents: b.totalCents },
  };
}
