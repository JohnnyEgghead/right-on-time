// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildMatcher, LINK_PREFIXES, norm, phoneForms, readLinks, run, type Customer } from './scan.ts';

// Synthetic people only (555-01xx numbers, made-up streets): the real scan reads the database of the e2e run, and this file holds no real value.
const people: Customer[] = [
  { mobile: '(614) 555-0171', homePhone: '', street: 'Oak Ridge Dr', house: '1234' },
  { mobile: '', homePhone: '937-555-0142', street: 'Maple Ave', house: '88' },
];
const m = buildMatcher(people);
const kinds = (line: string): string[] => m.find(line).map((x) => `${x.kind}:${x.customer}`);

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function collected(over: { logs?: Record<string, string>; customers?: string; links?: string } = {}): string {
  const d = mkdtempSync(path.join(tmpdir(), 'bw-privacy-test-'));
  dirs.push(d);
  mkdirSync(path.join(d, 'logs'));
  const logs = over.logs ?? Object.fromEntries(['proxy', 'web', 'worker', 'pbs', 'db', 'routing', 'setup'].map((s) => [s, '{"level":"info","msg":"started","status":200}\n']));
  for (const [k, v] of Object.entries(logs)) writeFileSync(path.join(d, 'logs', `${k}.log`), v);
  writeFileSync(path.join(d, 'customers.tsv'), over.customers ?? '(614) 555-0171\t\tOak Ridge Dr\t1234\n\t937-555-0142\tMaple Ave\t88\n');
  writeFileSync(path.join(d, 'links.tsv'), over.links ?? 'token\tk3Jd9xQa\ntarget\t/jobs/4821\n');
  return d;
}

describe('privacy scan: phones', () => {
  // why: NFR-05 a phone in any punctuation, with or without the area code or country code, is found
  it('finds a customer phone however it is written', () => {
    for (const line of ['p=(614) 555-0171', '6145550171', '+1 614 555 0171', '614.555.0171', 'tel:+16145550171', 'phone 555-0171', 'x 5550171 y', '937 555 0142', '/jobs?phone=%28614%29%20555-0171']) {
      expect(kinds(line), line).not.toEqual([]);
    }
  });
  // why: NFR-05 the scan is not noisy: times, ids, durations and a 7-digit slice of a longer number are not a phone
  it('does not flag timestamps, uuids, ports, or a 7-digit slice inside a longer number', () => {
    for (const line of ['{"time":"2026-09-15T07:00:00.123Z","ms":1789459200555,"duration":412,"status":200}', 'key 0e8b5b5c-6c7d-4f1a-9b2c-3d4e5f607182', 'port 55501710 id 99555017188', 'job 4821 route /jobs/4821']) {
      expect(kinds(line), line).toEqual([]);
    }
  });
  // why: NFR-05 a phone has a 10-digit and a 7-digit form; a short number has none
  it('forms: 10 digits and 7 digits, a leading 1 dropped, under 7 digits none', () => {
    expect(phoneForms('+1 (614) 555-0171')).toEqual({ full: '6145550171', local: '5550171' });
    expect(phoneForms('555-0171')).toEqual({ full: null, local: '5550171' });
    expect(phoneForms('12345')).toEqual({ full: null, local: null });
  });
});

describe('privacy scan: addresses', () => {
  // why: NFR-05 an address is the house number then the street name, in any case, spacing, punctuation or URL escape
  it('finds house number plus street name however it is written', () => {
    for (const line of ['at 1234 Oak Ridge Dr', '1234,OAK  RIDGE-DR.', '/search?q=1234%20oak%20ridge%20dr', '88 maple ave apt 2']) {
      expect(kinds(line), line).not.toEqual([]);
    }
  });
  // why: NFR-05 the street alone, or another house number on it, is not that customer's address
  it('does not flag the street alone or another house number', () => {
    for (const line of ['Oak Ridge Dr is closed', '1235 Oak Ridge Dr', '88 Maple Avenue']) expect(kinds(line), line).toEqual([]);
  });
  // why: NFR-05 norm makes spacing, case, punctuation and escapes agree
  it('norm', () => {
    expect(norm('123%20Oak-Ridge, Dr.')).toBe('123 oak ridge dr');
  });
});

describe('privacy scan: links', () => {
  // why: NFR-05 every token is rendered under every section 11.4 prefix, targets as they are, text-body links by shape
  it('reads the issued links', () => {
    const d = collected({ links: 'token\tabc12345\ntarget\t/jobs/9\ntext\tOn the way: https://x.invalid/m/abc12345 thanks\n' });
    const links = readLinks(path.join(d, 'links.tsv'));
    expect(links).toHaveLength(LINK_PREFIXES.length + 2);
    expect(links).toContain('/inbox/abc12345');
    expect(links).toContain('https://x.invalid/m/abc12345');
  });
});

describe('privacy scan: the run', () => {
  // why: NFR-05 clean logs and links give 0 hits, and the run proves its own positive control (planted phone with and without area code, planted address)
  it('passes clean input and finds its own planted lines', () => {
    const r = run(collected());
    expect(r.out.join('\n')).toContain('0 hit(s) in the logs and links');
    expect(r.out.join('\n')).toMatch(/phone with area code FOUND, phone without area code FOUND, address FOUND/);
    expect(r.rc).toBe(0);
  });
  // why: NFR-05 a log line holding a known customer phone fails the scan, names file and line, and does not print the phone
  it('fails on a planted test log line holding a customer phone, without printing the phone', () => {
    const d = collected({ logs: { proxy: 'ok\n', web: '{"msg":"a"}\n{"msg":"call 614-555-0171 back"}\n', worker: 'ok\n', pbs: 'ok\n', db: 'ok\n', routing: 'ok\n', setup: 'ok\n' } });
    const r = run(d);
    const text = r.out.join('\n');
    expect(r.rc).toBe(1);
    expect(text).toContain('logs/web.log:2 phone (customer row 1)');
    expect(text).not.toMatch(/555/);
  });
  // why: NFR-05 a customer address in an issued link fails the scan
  it('fails on an address in a link target', () => {
    const r = run(collected({ links: 'token\tk3Jd9xQa\ntarget\t/map?to=88+Maple+Ave\n' }));
    expect(r.rc).toBe(1);
    expect(r.out.join('\n')).toContain('links.tsv:');
  });
  // why: NFR-05 an empty population is a failure, never a pass: no customers, a missing log, no links
  it('fails on an empty or incomplete population', () => {
    expect(run(collected({ customers: '' })).rc).toBe(1);
    expect(run(collected({ logs: { web: 'x\n' } })).rc).toBe(1);
    expect(run(collected({ links: '' })).rc).toBe(1);
  });
});
