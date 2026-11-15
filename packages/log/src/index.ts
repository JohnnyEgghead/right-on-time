// SPDX-License-Identifier: AGPL-3.0-or-later
// @bw/log (SPECIFICATIONS section 11.4, SD-42; invariant 6's code half; NFR-05): every process logs JSON lines to
// stdout through this package, whose typed allowlist admits only real and demo time, level, process, contract ID, route
// template, status, duration, error code, user id and job number. A call that passes any other field fails type
// checking, for an object literal and for a variable alike (Exact below). At run time any other key a cast or a
// plain-JavaScript caller slips in is dropped, so it never reaches a line either.
import { realNow, type Clock } from '@bw/time';

export const LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type Level = (typeof LEVELS)[number];

export const PROCESSES = ['web', 'worker', 'pbs', 'migrate', 'setup'] as const;
export type ProcessName = (typeof PROCESSES)[number];

/**
 * A process state, for lines that carry no HTTP status. A fixed list, never free text: free text is where a phone
 * number or address would slip into a log. A new state is added here, in review.
 */
export const PROCESS_STATES = [
  'listening', 'stopping', 'started', 'demo mode on', 'migrated', 'logins set', 'access cookie key generated', 'unhandled error', 'access code sync failed',
  // Setup's steps (P2-SETUP, D-3); 'import started' to 'import committed' is the measured import run time (section 14).
  'setup started', 'reference seed written', 'export generated', 'dry run done', 'import started', 'import committed',
  'world seed written', 'snapshot written', 'setup done', 'setup refused', 'maps not checked',
  // The worker's clock job (P3-REPLAY, SD-12): a reset the idle watcher or the nightly job made, and a reset confirmed.
  'world reset idle', 'world reset nightly', 'world reset confirmed',
  // The worker's import job (P3-IMPORT-WORKER): 1 office run executed to done, or ended failed (errorCode names why).
  'import run done', 'import run failed',
  // Its export check (apps/worker/src/import/check.ts, run after every deploy): the export matched the manifest, or not.
  'import source ok', 'import source refused',
  // The live route client's signal (P6-ROUTE-SIGNAL, F-1306): live routing failed; errorCode names the cause class, failures the count.
  'live route failed',
] as const;
export type ProcessState = (typeof PROCESS_STATES)[number];

/** The fields a caller may pass. Real time, level and process are written by the logger itself. */
export interface LogFields {
  /** Demo time (RFC 9557), when the caller has it (the kernel does, per request). */
  demoTime?: string;
  contract?: `API-${number}`;
  /** A route template (`/jobs/{jobNumber}`), never a filled path. */
  route?: string;
  status?: number | ProcessState;
  durationMs?: number;
  errorCode?: string;
  userId?: string;
  jobNumber?: number;
  /** A count of failures since the last line of the same kind (P6-ROUTE-SIGNAL): a number, never a subject. */
  failures?: number;
}

export const LOG_FIELDS = ['demoTime', 'contract', 'route', 'status', 'durationMs', 'errorCode', 'userId', 'jobNumber', 'failures'] as const satisfies readonly (keyof LogFields)[];

/** The type a field outside the allowlist must have: nothing can be one, and the compiler's message names the field. */
export interface NotInLogAllowlist<K> {
  readonly notInLogAllowlist: K;
}

/** T with every key outside the allowlist mapped to NotInLogAllowlist: a value for such a key is a type error. */
export type Exact<T> = T & { [K in Exclude<keyof T, keyof LogFields>]: NotInLogAllowlist<K> };

export type LogFn = <T extends LogFields>(fields: Exact<T>) => void;

export interface Logger {
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
}

export interface LoggerOptions {
  process: ProcessName;
  /** The clock seam, for the real-time stamp (section 11.3 use `log_stamp`); default the system clock through @bw/time. */
  clock?: Pick<Clock, 'realNow'>;
  level?: Level;
  /** Where lines go; default stdout. */
  write?: (line: string) => void;
}

const ALLOWED: ReadonlySet<string> = new Set(LOG_FIELDS);
const RANK: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const STATES: ReadonlySet<string> = new Set(PROCESS_STATES);

/** Keep only allowlisted keys with values of the allowed kinds (run-time half of the allowlist). */
export function allowlisted(fields: Record<string, unknown>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (!ALLOWED.has(k) || v === undefined) continue;
    if (k === 'status') {
      if (typeof v === 'number' || (typeof v === 'string' && STATES.has(v))) out[k] = v;
    } else if (k === 'durationMs' || k === 'jobNumber' || k === 'failures') {
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    } else if (typeof v === 'string') {
      out[k] = v;
    }
  }
  return out;
}

export function createLogger(opts: LoggerOptions): Logger {
  const min = RANK[opts.level ?? 'info'];
  const write = opts.write ?? ((line: string) => void process.stdout.write(line));
  const clock = opts.clock;
  const stamp = clock ? () => clock.realNow('log_stamp') : () => realNow('log_stamp');
  const at = (level: Level): LogFn => (fields) => {
    if (RANK[level] < min) return;
    const line = { realTime: stamp().toString(), level, process: opts.process, ...allowlisted(fields as Record<string, unknown>) };
    write(`${JSON.stringify(line)}\n`);
  };
  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}
