// SPDX-License-Identifier: AGPL-3.0-or-later
// @bw/log: the typed field allowlist of SPECIFICATIONS section 11.4 (invariant 6's code half). The type half is proved
// by compiling the committed cases in packages/log/cases with the TypeScript compiler: each planted call must fail
// with a diagnostic naming the field, and the clean case must compile, so a quiet compiler alone proves nothing.
// The cases are kept as .case text (they must not join the package's own typecheck) and compiled as the .ts file of the
// same name, in place, so their imports resolve exactly as a source file's would.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { FixedClock } from '@bw/time';
import { allowlisted, causeCodeOf, createLogger, exitOnUncaughtException, exitOnUnhandledRejection, LOG_FIELDS } from './index.ts';

const cases = path.resolve(import.meta.dirname, '..', 'cases');

const CASE_FILES = ['bad-literal.ts', 'bad-variable.ts', 'bad-free-text.ts', 'bad-event-subject.ts', 'good.ts'];
let compiled: ts.Program | undefined;

/**
 * One TypeScript program over every case, built once (F-684): each case used to build its own program, 4 full compiles of the
 * log package and the libs in 1 file, which is the CPU a loaded host under 3 zones ran out of at the 60 s test limit.
 */
function program(): ts.Program {
  if (compiled) return compiled;
  const configPath = path.resolve(import.meta.dirname, '..', 'tsconfig.json');
  const cfg = ts.getParsedCommandLineOfConfigFile(configPath, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined });
  if (!cfg) throw new Error('cannot read packages/log/tsconfig.json');
  const options = { ...cfg.options, noEmit: true };
  const texts = new Map(CASE_FILES.map((f) => [path.join(cases, f), readFileSync(path.join(cases, f.replace(/\.ts$/, '.case')), 'utf8')]));
  const host = ts.createCompilerHost(options);
  const { getSourceFile, fileExists, readFile } = host;
  host.fileExists = (f) => texts.has(f) || fileExists.call(host, f);
  host.readFile = (f) => texts.get(f) ?? readFile.call(host, f);
  host.getSourceFile = (f, lang, ...rest) => (texts.has(f) ? ts.createSourceFile(f, texts.get(f)!, lang) : getSourceFile.call(host, f, lang, ...rest));
  compiled = ts.createProgram([...texts.keys()], options, host);
  return compiled;
}

function diagnostics(file: string): string[] {
  const p = program();
  const source = p.getSourceFile(path.join(cases, file));
  if (!source) throw new Error(`case ${file} is not in the program`);
  return ts.getPreEmitDiagnostics(p, source).map((d) => `${path.basename(d.file?.fileName ?? '?')}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`);
}

describe('@bw/log allowlist, type half', () => {
  // why: NFR-05, SD-42
  it('fails type checking for a field outside the allowlist in an object literal', () => {
    const d = diagnostics('bad-literal.ts');
    expect(d.length).toBeGreaterThan(0);
    expect(d.join('\n')).toMatch(/bad-literal\.ts: [\s\S]*NotInLogAllowlist<"phone">/);
  });

  // why: NFR-05, SD-42
  it('fails type checking for a field outside the allowlist carried in a variable', () => {
    const d = diagnostics('bad-variable.ts');
    expect(d.length).toBeGreaterThan(0);
    expect(d.join('\n')).toMatch(/bad-variable\.ts: [\s\S]*NotInLogAllowlist<"address">/);
  });

  // why: NFR-05, SD-42
  it('fails type checking for free text in the status field', () => {
    expect(diagnostics('bad-free-text.ts').join('\n')).toMatch(/^bad-free-text\.ts: .*texted 614-555-0100/m);
  });

  // why: F-1844, NFR-05: the 2 new event fields widen the list by exactly 2, so the event's subject still fails to compile.
  it('fails type checking for a field outside the new list on an event line', () => {
    const d = diagnostics('bad-event-subject.ts');
    expect(d.length).toBeGreaterThan(0);
    expect(d.join('\n')).toMatch(/bad-event-subject\.ts: [\s\S]*NotInLogAllowlist<"subject">/);
    expect(d.join('\n')).not.toMatch(/eventKind|eventId/);
  });

  // why: NFR-05, SD-42
  it('compiles a call with every allowlisted field, as a literal and as a variable', () => {
    expect(diagnostics('good.ts')).toEqual([]);
  });
});

describe('@bw/log lines', () => {
  const clock = new FixedClock({ demo: '2026-09-15T14:00:00Z', real: '2026-11-01T12:00:00Z' });

  // why: NFR-05, SD-42
  it('writes 1 JSON line with real time, level and process, and only allowlisted fields', () => {
    const lines: string[] = [];
    const log = createLogger({ process: 'web', clock, write: (l) => lines.push(l) });
    log.info({ contract: 'API-171', route: '/healthz', status: 200, durationMs: 3 });
    // A cast or a plain-JavaScript caller: the run-time half drops what the type half would refuse.
    (log.warn as (f: Record<string, unknown>) => void)({ status: 'texted 6145550100', errorCode: 'not_found', phone: '6145550100', address: '1 Main St', jobNumber: '2481' });
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.endsWith('\n'))).toBe(true);
    expect(JSON.parse(lines[0]!)).toEqual({ realTime: '2026-11-01T12:00:00Z', level: 'info', process: 'web', contract: 'API-171', route: '/healthz', status: 200, durationMs: 3 });
    expect(JSON.parse(lines[1]!)).toEqual({ realTime: '2026-11-01T12:00:00Z', level: 'warn', process: 'web', errorCode: 'not_found' });
    expect(lines.join('')).not.toMatch(/6145550100|Main St/);
  });

  // why: NFR-05
  it('honors the level and never lets a caller overwrite real time, level or process', () => {
    const lines: string[] = [];
    const log = createLogger({ process: 'worker', clock, level: 'warn', write: (l) => lines.push(l) });
    log.info({ status: 'started' });
    (log.error as (f: Record<string, unknown>) => void)({ level: 'debug', process: 'pbs', realTime: 'x', status: 500 });
    expect(lines.map((l) => JSON.parse(l))).toEqual([{ realTime: '2026-11-01T12:00:00Z', level: 'error', process: 'worker', status: 500 }]);
    expect(Object.keys(allowlisted({ demoTime: 'a', userId: 'u' }))).toEqual(['demoTime', 'userId']);
    expect(LOG_FIELDS).toEqual(['demoTime', 'contract', 'route', 'status', 'durationMs', 'errorCode', 'userId', 'jobNumber', 'failures', 'eventKind', 'eventId']);
  });

  // why: F-1844, NFR-05: the run-time half of the 2 new fields keeps only a dotted kind and a UUID, so a cast can never carry text.
  it('keeps an event kind and an event id only in their shapes', () => {
    const id = '0192f0a4-1111-4222-8333-944455556666';
    expect(allowlisted({ eventKind: 'text.try', eventId: id })).toEqual({ eventKind: 'text.try', eventId: id });
    expect(allowlisted({ eventKind: 'billing.retry', eventId: id.toUpperCase() })).toEqual({ eventKind: 'billing.retry', eventId: id.toUpperCase() });
    for (const bad of ['texted 6145550100', 'text', 'Text.Try', 'text.try ', '1 Main St.x', 'a.b.c.d.e', 42]) {
      expect(allowlisted({ eventKind: bad })).toEqual({});
    }
    for (const bad of ['2481', 'job 2481', `${id} 6145550100`, id.replace(/-/g, ''), 7]) {
      expect(allowlisted({ eventId: bad })).toEqual({});
    }
  });
});

describe('@bw/log causeCodeOf', () => {
  // why: F-1844, F-1845, NFR-05: a cause code is the error's code or class name, never its message.
  it('answers the code, else the class name, else Error, and never the message', () => {
    const pg = Object.assign(new Error('duplicate key value (phone)=(6145550100)'), { code: '23505' });
    expect(causeCodeOf(pg)).toBe('23505');
    expect(causeCodeOf(Object.assign(new Error('connect 10.0.0.1'), { code: 'ECONNREFUSED' }))).toBe('ECONNREFUSED');
    expect(causeCodeOf(new TypeError('1 Main St is not a function'))).toBe('TypeError');
    class RouteDown extends Error { override name = 'RouteDown'; }
    expect(causeCodeOf(new RouteDown('x'))).toBe('RouteDown');
    // A code or name that is not identifier-shaped (it could be text) falls through; a thrown string or nothing is Error.
    expect(causeCodeOf(Object.assign(new Error('m'), { code: 'call 614-555-0100' }))).toBe('Error');
    expect(causeCodeOf(Object.assign(new Error('m'), { code: '', name: 'texted 6145550100' }))).toBe('Error');
    expect(causeCodeOf('6145550100')).toBe('Error');
    expect(causeCodeOf(null)).toBe('Error');
    expect(causeCodeOf(undefined)).toBe('Error');
    expect(causeCodeOf({ code: 42, name: 'AbortError' })).toBe('AbortError');
  });
});

describe('@bw/log exitOnUnhandledRejection', () => {
  const clock = new FixedClock({ demo: '2026-09-15T14:00:00Z', real: '2026-11-01T12:00:00Z' });

  // why: F-1845: an unhandled rejection is an error-level line with its cause code, then exit 1 once the line is flushed.
  it('logs the cause code at error level and exits 1 after stdout flushed, once', () => {
    const lines: string[] = [];
    const exits: number[] = [];
    let listener: ((reason: unknown) => void) | undefined;
    const flushes: (() => void)[] = [];
    const proc = {
      on: (_: 'unhandledRejection', l: (reason: unknown) => void) => { listener = l; },
      exit: (code: number) => { exits.push(code); },
      stdout: { write: (_: string, cb: () => void) => { flushes.push(cb); return true; } },
    };
    exitOnUnhandledRejection(createLogger({ process: 'worker', clock, write: (l) => lines.push(l) }), proc);
    listener!(new TypeError('customer 6145550100 at 1 Main St'));
    listener!(Object.assign(new Error('second'), { code: 'ECONNRESET' }));
    expect(exits).toEqual([]);
    expect(flushes).toHaveLength(1);
    flushes[0]!();
    expect(exits).toEqual([1]);
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { realTime: '2026-11-01T12:00:00Z', level: 'error', process: 'worker', status: 'unhandled rejection', errorCode: 'TypeError' },
      { realTime: '2026-11-01T12:00:00Z', level: 'error', process: 'worker', status: 'unhandled rejection', errorCode: 'ECONNRESET' },
    ]);
    expect(lines.join('')).not.toMatch(/6145550100|Main St|second/);
  });
});

describe('@bw/log exitOnUncaughtException', () => {
  const clock = new FixedClock({ demo: '2026-09-15T14:00:00Z', real: '2026-11-01T12:00:00Z' });

  // why: F-1870: an uncaught exception is an error-level line with its cause code and no message, then exit 1 once the line is flushed.
  it('logs the cause code at error level and exits 1 after stdout flushed, once', () => {
    const lines: string[] = [];
    const exits: number[] = [];
    const events: string[] = [];
    let listener: ((reason: unknown) => void) | undefined;
    const flushes: (() => void)[] = [];
    const proc = {
      on: (event: 'unhandledRejection' | 'uncaughtException', l: (reason: unknown) => void) => { events.push(event); listener = l; },
      exit: (code: number) => { exits.push(code); },
      stdout: { write: (_: string, cb: () => void) => { flushes.push(cb); return true; } },
    };
    exitOnUncaughtException(createLogger({ process: 'pbs', clock, write: (l) => lines.push(l) }), proc);
    expect(events).toEqual(['uncaughtException']);
    listener!(new RangeError('customer 6145550100 at 1 Main St'));
    listener!(Object.assign(new Error('second'), { code: 'EPIPE' }));
    expect(exits).toEqual([]);
    expect(flushes).toHaveLength(1);
    flushes[0]!();
    expect(exits).toEqual([1]);
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { realTime: '2026-11-01T12:00:00Z', level: 'error', process: 'pbs', status: 'uncaught exception', errorCode: 'RangeError' },
      { realTime: '2026-11-01T12:00:00Z', level: 'error', process: 'pbs', status: 'uncaught exception', errorCode: 'EPIPE' },
    ]);
    expect(lines.join('')).not.toMatch(/6145550100|Main St|second/);
  });
});
