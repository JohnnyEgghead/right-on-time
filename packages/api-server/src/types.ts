// SPDX-License-Identifier: AGPL-3.0-or-later
// The kernel's types (SPECIFICATIONS section 4.1, SD-6, SD-7). Handlers are plain functions over a framework-neutral
// request; the policy table is the only route registry, for the API rows and for every page route.
import type { ContractRow, ErrorCode, Label, ROLES, TOKEN_KINDS } from '@bw/api';
import type { Settings } from '@bw/config';
import type { BusEvent, Queryable } from '@bw/db';
import type { Logger } from '@bw/log';
import type { Clock, Instant } from '@bw/time';
import type { ZodType } from 'zod';
import type { Presented } from './kernel/sessions.ts';

export type Role = (typeof ROLES)[number];
export type TokenKind = (typeof TOKEN_KINDS)[number];
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type Access =
  | { kind: 'public' }
  | { kind: 'token'; tokenKind: TokenKind }
  | { kind: 'roles'; roles: readonly Role[] }
  | { kind: 'one_time' };

/** An API entry: 1 per `API-<nn>` row. Its method, path, schemas and codes are the row's (built by `api()` in policy/entry.ts). */
export interface ApiPolicyEntry {
  kind: 'api';
  contract: `API-${number}`;
  method: HttpMethod;
  /** The served path template (under /api/v1, or at the origin root for the 7.1 exceptions). */
  path: string;
  access: Access;
  /** true only for API-01, API-02, API-03, API-10 and API-105 (SPECIFICATIONS 4.1). */
  beforeAccessCode: boolean;
  request: ZodType;
  response: ZodType;
  errors: readonly ErrorCode[];
  row: ContractRow;
}

/** A page entry: 1 per page route, with its access: public, roles, a token or a one-time link (UI-SPECIFICATION 2.3, section 2.4). */
export interface PagePolicyEntry {
  kind: 'page';
  screen: `SCR-${string}`;
  path: string;
  access: Access;
  /** true only for the 2 sign-in pages (SD-47 step 1: they answer without the access code). */
  beforeAccessCode: boolean;
}

export type PolicyEntry = ApiPolicyEntry | PagePolicyEntry;

/** Who is calling, as the session layer resolved it. A link-token holder is decided per route, not here. */
export type Caller =
  | { kind: 'staff'; userId: string; role: Role; client: 'web' | 'native'; via: 'password' | 'sign_in_as' }
  | { kind: 'anonymous' };

export interface ApiRequest {
  contract: string;
  /** The validated request: path parameters, query values and body fields, flat (the row's request schema output). */
  params: unknown;
  /** The raw JSON body of a write, or null. */
  body: unknown;
  caller: Caller;
  worldEpoch: number;
  demoNow: Instant;
}

export type ApiResult<T> =
  /** `fileName`: the name of a file row's download when it varies by the call (API-159, SPECIFICATIONS 7.5; letters, digits, dots, dashes and underscores only, else the row's own name). `cookies`: Set-Cookie values the kernel puts on the answer; only API-01 (bw_access), API-03 and API-05 (bw_session) may set them, the kernel answers server_error for any other row or name (F-289). */
  | { ok: true; status: 200 | 201 | 202 | 204; data: T; labels?: Label[]; cookies?: string[]; fileName?: string }
  | { ok: false; status: number; code: ErrorCode; detail?: unknown };

/** The transaction a handler runs in: every repository call inside it joins it (SD-6: 1 transaction per call). */
export type Tx = Queryable;

/** The settings the kernel and the auth handlers read; the first 3 are required, the rest default (a test kit sets only what it needs). */
export type KernelSettings = Readonly<
  Pick<Settings, 'APP_ORIGIN' | 'DEMO_MODE' | 'ACCESS_CODE_ON'> &
    Partial<Pick<Settings, 'SAMPLE_PASSWORD_SEED' | 'SOURCE_REPO_URL' | 'PUBLIC_COMMIT' | 'IOS_INSTALL_KIND' | 'IOS_INSTALL_LINK' | 'PHOTOS_DIR' | 'TEXT_LINK_HOST' | 'PBS_URL' | 'RESET_COOLDOWN_SECONDS' | 'RESET_PROTECTION' | 'BACKUP_TARGET' | 'DATA_LOCATION_APP' | 'DATA_LOCATION_BACKUPS' | 'DATA_LOCATION_TEXTS' | 'DATA_LOCATION_MAPS'>>
>;

/** What the kernel hands a handler besides the request: the settings and clock it runs under, and how the caller was recognized. */
export interface HandlerContext {
  settings: KernelSettings;
  clock: Pick<Clock, 'realNow'>;
  /** The bw_access signing key; null except for API-01, the one row that issues the access cookie (F-289). */
  accessKey: string | null;
  /** Whether the request arrived over https (requestIsHttps): the bw_access cookie is Secure only then (F-304). */
  secure: boolean;
  /** Whether the request carried a valid bw_access cookie (the access code entered, F-288): API-04, API-05 and API-15 list people only after it. */
  codeEntered: boolean;
  /** The session token this request presented (cookie or bearer); null except for API-06, which ends it (F-289). */
  presented: Presented | null;
  /** The process's event bus; null except for a stream row (API-09, F-344) and API-172, and null when the process has none. */
  events: EventBusPort | null;
  /** The kernel's log: a handler that keeps going past a failure logs its cause here (F-661). */
  log: Logger;
}

/** The process's event bus as the API-09 handler uses it (events/bus.ts PgNotifyBus, 1 LISTEN connection per process). */
export interface EventBusPort {
  readonly listening: boolean;
  /** Resolves once the LISTEN connection is up or `withinMs` passed; answers whether it is listening. */
  ready(withinMs?: number): Promise<boolean>;
  subscribe(filter: { branch?: string | undefined; role: Role }, onEvent: (e: BusEvent) => void, onLost?: () => void): () => void;
  /** The real time (ms) a seq was emitted, while the process still keeps it (60 s, SD-43); undefined after. */
  emitTime(seq: number): number | undefined;
}

export type Handler<T> = (req: ApiRequest, tx: Tx, ctx: HandlerContext) => Promise<ApiResult<T>>;

/** Decides whether a link token or a one-time link is valid for its route (an area lane registers 1 per kind). */
export type TokenCheck = (token: string, tx: Tx) => Promise<boolean>;
