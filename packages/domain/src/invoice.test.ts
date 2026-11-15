// SPDX-License-Identifier: AGPL-3.0-or-later
// Invoice composition (SD-20; FR-BILL-13, FR-BILL-1) and pbs's check of what it receives, pure.
import { describe, expect, it } from 'vitest';
import { composeInvoice, DISCOUNT_LABEL, laborLabel, validateInvoice, type InvoiceLine, type InvoiceSource } from './invoice.ts';

const CAP = { code: 'CAP-455', name: 'Run capacitor 45/5 MFD', priceCents: 3800 };
const FILTER = { code: 'FLT-16251', name: 'Furnace filter 16x25x1 MERV 8', priceCents: 950 };
const base: InvoiceSource = {
  jobNumber: 24812, customerName: 'Whitaker', doneAt: '2026-09-15T14:15:00Z', serviceId: 'furnace_tune_up', servicePriceCents: 8900,
  parts: [], laborMinutes: 65, workDone: [], member: false,
};
const ok = (src: InvoiceSource) => {
  const r = composeInvoice(src);
  if (!r.ok) throw new Error(r.reason);
  return r;
};
/** An independent sum: priced lines only, written out here rather than through invoiceTotal. */
const independentSum = (lines: InvoiceLine[]) => {
  let t = 0;
  for (const l of lines) if (l.kind !== 'work_done') t += l.amountCents as number;
  return t;
};

describe('composeInvoice (SD-20)', () => {
  // why: FR-BILL-13
  it("gives a member's furnace tune-up with 2 parts the service, 2 part lines, labor, the discount and an equal total", () => {
    const r = ok({ ...base, member: true, parts: [{ ...CAP, quantity: 1 }, { ...FILTER, quantity: 2 }] });
    expect(r.lines.map((l) => [l.kind, l.label, l.code, l.quantity, l.unitCents, l.amountCents])).toEqual([
      ['service', 'Furnace tune-up', null, 1, 8900, 8900],
      ['part', 'Run capacitor 45/5 MFD', 'CAP-455', 1, 3800, 3800],
      ['part', 'Furnace filter 16x25x1 MERV 8', 'FLT-16251', 2, 950, 1900],
      ['labor', 'Hours worked: 1 hr 5 min', null, null, 0, 0],
      ['discount', DISCOUNT_LABEL, null, null, null, -1335],
    ]);
    expect(r.totalCents).toBe(independentSum(r.lines));
    expect(r.totalCents).toBe(8900 + 3800 + 1900 - 1335);
  });

  // why: FR-BILL-13
  it('gives the same job for a non-member no discount line', () => {
    const r = ok({ ...base, parts: [{ ...CAP, quantity: 1 }, { ...FILTER, quantity: 2 }] });
    expect(r.lines.some((l) => l.kind === 'discount')).toBe(false);
    expect(r.totalCents).toBe(8900 + 3800 + 1900);
  });

  // why: FR-BILL-13
  it("gives a non-member's Heating or AC fix with No parts used a $79.00 service line, a labor line and a $79.00 total", () => {
    const r = ok({ ...base, serviceId: 'heating_or_ac_fix', servicePriceCents: 7900, laborMinutes: 90 });
    expect(r.lines.map((l) => l.kind)).toEqual(['service', 'labor']);
    expect(r.lines[0]).toMatchObject({ label: 'Heating or AC fix', amountCents: 7900 });
    expect(r.totalCents).toBe(7900);
  });

  // why: FR-BILL-13
  it('takes 15% off the service line only, rounded half-up, and $0.00 off a $0.00 service', () => {
    expect(ok({ ...base, member: true, servicePriceCents: 8900 }).lines.at(-1)?.amountCents).toBe(-1335);
    // 7,950 x 15% = 1,192.5 cents: half-up gives 1,193.
    expect(ok({ ...base, member: true, servicePriceCents: 7950 }).lines.at(-1)?.amountCents).toBe(-1193);
    const zero = ok({ ...base, member: true, serviceId: 'water_heater', servicePriceCents: 0, parts: [{ ...CAP, quantity: 3 }] });
    expect(zero.lines.at(-1)).toMatchObject({ kind: 'discount', amountCents: 0 });
    expect(zero.totalCents).toBe(11400);
  });

  // why: FR-BILL-13, FR-BILL-1
  it('places the work-done lines after labor with no amount, and keeps them out of the total', () => {
    const r = ok({ ...base, member: true, workDone: ['All readings normal', 'Replaced 2 return filters'] });
    expect(r.lines.map((l) => l.kind)).toEqual(['service', 'labor', 'work_done', 'work_done', 'discount']);
    expect(r.lines.filter((l) => l.kind === 'work_done').every((l) => l.amountCents === null)).toBe(true);
    expect(r.totalCents).toBe(8900 - 1335);
  });

  // why: FR-BILL-1
  it('writes the labor hours worked: 2 hr 9 min, 45 min, 1 hr, 0 min', () => {
    expect([129, 45, 60, 0].map(laborLabel)).toEqual(['Hours worked: 2 hr 9 min', 'Hours worked: 45 min', 'Hours worked: 1 hr', 'Hours worked: 0 min']);
  });

  // why: FR-BILL-7
  it('answers a data error for a service with no invoice line', () => {
    expect(composeInvoice({ ...base, serviceId: 'no_such_service' })).toEqual({ ok: false, reason: 'service no_such_service has no invoice line' });
  });
});

describe('validateInvoice (pbs receipt)', () => {
  const sent = () => {
    const r = ok({ ...base, member: true, parts: [{ ...CAP, quantity: 1 }], workDone: ['Cleaned the burners.'] });
    return { jobNumber: 24812, customerName: 'Whitaker', doneAt: base.doneAt, sentAt: '2026-09-15T14:16:00Z', lines: r.lines, totalCents: r.totalCents };
  };

  // why: FR-BILL-13, FR-BILL-4
  it('accepts what composeInvoice composed', () => {
    expect(validateInvoice(sent())).toEqual({ ok: true, invoice: sent() });
  });

  // why: FR-BILL-7
  it('answers a reason in words for a total that is not the sum, a part line off its price, and a missing service line', () => {
    expect(validateInvoice({ ...sent(), totalCents: 1 })).toEqual({ ok: false, reason: 'the total does not equal the sum of the priced lines' });
    const lines = sent().lines.map((l) => (l.kind === 'part' ? { ...l, amountCents: 1 } : l));
    expect(validateInvoice({ ...sent(), lines })).toMatchObject({ ok: false, reason: expect.stringMatching(/list price times its quantity/) });
    expect(validateInvoice({ ...sent(), lines: sent().lines.slice(1) })).toMatchObject({ ok: false, reason: expect.stringMatching(/exactly 1 service line/) });
    expect(validateInvoice(null)).toMatchObject({ ok: false });
  });
});
