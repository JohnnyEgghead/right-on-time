// SPDX-License-Identifier: AGPL-3.0-or-later
// @bw/log (SPECIFICATIONS section 11.4, SD-42; invariant 6's code half; NFR-05): every process logs JSON lines to
// stdout through this package, whose typed allowlist admits only real and demo time, level, process, contract ID, route
// template, status, duration, error code, user id, job number, failures, event kind and event id. A call that passes any other field fails type
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
  // P9-AUDIT-SERVER (F-1844): 1 run of a scheduled event failed (eventKind, eventId; errorCode is the safe cause code), its
  // kind gave it up after MAX_HANDLER_FAILURES runs, the failure count could not be written, or the give-up itself threw.
  'event failed', 'event gave up', 'event failure not counted', 'event give-up failed',
  // F-1846: a background loop that keeps failing repeats its line every 10 real minutes and logs once when it recovers.
  'dispatcher pass failed', 'dispatcher pass recovered',
  'clock replay failed', 'clock replay recovered', 'reset confirmer failed', 'reset confirmer recovered',
  'auto reset failed', 'auto reset recovered', 'cleanup failed', 'cleanup recovered',
  // F-1848: the access code sync answered again after a failure. F-1845: a promise rejection no code handled.
  'access code sync recovered', 'unhandled rejection',
  // F-1870: an exception no code caught, in a process that hooks it.
  'uncaught exception',
  // F-2006 (K-10.1, K-10.2, K-10.4, J-24): a worker step that failed, each with its cause code: a billing reset the
  // confirmer could not send, the healer, the heartbeat, a job that could not start, a stop that threw, and a late text
  // given up after its tries.
  'billing reset failed', 'billing heal failed', 'heartbeat failed', 'job start failed', 'stop failed', 'late text gave up',
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
  /** A count of failures: since the last line of the same kind (the live route signal, F-1306; a background loop's failed line, F-1846), or the whole outage on a loop's recovered line. A number, never a subject. */
  failures?: number;
  /** A scheduled_event kind (`text.try`, F-1844): dotted lower-case words, never a subject or payload. */
  eventKind?: string;
  /** A scheduled_event id (F-1844): a UUID, never a subject. */
  eventId?: string;
}

export const LOG_FIELDS = ['demoTime', 'contract', 'route', 'status', 'durationMs', 'errorCode', 'userId', 'jobNumber', 'failures', 'eventKind', 'eventId'] as const satisfies readonly (keyof LogFields)[];

/** The run-time shape of eventKind and eventId: a value of any other shape is dropped, so free text never reaches a line. */
export const EVENT_KIND_SHAPE = /^[a-z][a-z_]{0,30}(\.[a-z][a-z_]{0,30}){1,3}$/;
export const EVENT_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The shape a cause code must have (as the import runner's failureCode and F-561's errorCodeOf check it). */
const CAUSE_SHAPE = /^[A-Za-z0-9_]{2,40}$/;

/**
 * The safe cause code of a thrown value (F-1844, F-1845; made from apps/worker/src/alerts/check.ts failureOf, which now
 * calls it): its `code` (a PostgreSQL SQLSTATE such as 40P01, a Node code such as ECONNREFUSED), else its class name
 * (TypeError), else `Error`. Both are shape-checked, and the message is never read: a message can quote a record's text.
 */
export function causeCodeOf(e: unknown): string {
  const err = e as { code?: unknown; name?: unknown } | null | undefined;
  if (typeof err?.code === 'string' && CAUSE_SHAPE.test(err.code)) return err.code;
  if (typeof err?.name === 'string' && CAUSE_SHAPE.test(err.name)) return err.name;
  return 'Error';
}

/**
 * F-2006 (K-10.2, J-21): an error event of `source` (a pg Pool: an idle connection the server ended) is logged at error
 * level with its cause code. With no listener the event would throw, and the process would end on it.
 */
export function logErrorEvents(source: { on(event: 'error', listener: (e: unknown) => void): unknown }, log: Pick<Logger, 'error'>): void {
  source.on('error', (e) => log.error({ status: 'unhandled error', errorCode: causeCodeOf(e) }));
}

/** The process seam of exitOnUnhandledRejection (a test passes a fake). */
export interface RejectionProcess {
  on(event: 'unhandledRejection' | 'uncaughtException', listener: (reason: unknown) => void): unknown;
  exit(code: number): never | void;
  stdout: { write(chunk: string, cb: () => void): boolean };
}

/**
 * F-1845: a promise rejection no code handled is logged at error level with its safe cause code, then the process exits 1,
 * as Node's own default would, so Compose's restart policy still restarts it. Node's default would also print the message
 * and stack to stderr, which can quote a record's text; this line never does. The exit waits for stdout to flush the line.
 */
export function exitOnUnhandledRejection(log: Logger, proc: RejectionProcess = process as unknown as RejectionProcess): void {
  let exiting = false;
  proc.on('unhandledRejection', (reason) => {
    log.error({ status: 'unhandled rejection', errorCode: causeCodeOf(reason) });
    if (exiting) return;
    exiting = true;
    proc.stdout.write('', () => proc.exit(1));
  });
}

/**
 * F-1870: an exception no code caught is logged at error level with its safe cause code, then the process exits 1 (as Node's own
 * default does, so Compose's restart policy still restarts it). Node's default would print the message and stack to stderr
 * before it exits, which can quote a record's text; with this listener installed nothing else prints them. The exit waits for
 * stdout to flush the line.
 */
export function exitOnUncaughtException(log: Logger, proc: RejectionProcess = process as unknown as RejectionProcess): void {
  let exiting = false;
  proc.on('uncaughtException', (error) => {
    log.error({ status: 'uncaught exception', errorCode: causeCodeOf(error) });
    if (exiting) return;
    exiting = true;
    proc.stdout.write('', () => proc.exit(1));
  });
}

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
    } else if (k === 'eventKind') {
      if (typeof v === 'string' && EVENT_KIND_SHAPE.test(v)) out[k] = v;
    } else if (k === 'eventId') {
      if (typeof v === 'string' && EVENT_ID_SHAPE.test(v)) out[k] = v;
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
