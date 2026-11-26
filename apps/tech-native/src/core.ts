// SPDX-License-Identifier: AGPL-3.0-or-later
// The native app's controller (P6-NATIVE-SHELL; SPECIFICATIONS 6.12, SD-47 Native app; FR-IOS-3): the server address, the session in
// the Keychain, and the shared item engine over the file store. Platform-free: every phone service comes in through NativeDeps
// (src/boot.ts wires expo-file-system, expo-secure-store, the background uploads and the system clock), so the tests run it on node:fs.
//
// Durable state and what a relaunch reads back:
//   the server address    SettingsFile (its own directory): written only by saveServer, after API-105 checked it (SCR-TEC-12)
//   the session           SessionStore (the Keychain): written by signIn, removed by signOut and by a 401 the server answers
//   the waiting items     FileItemStore: written by enter(), removed only by their answers (model.ts I1 to I5)
// A relaunch builds a new controller over the same 3: the items, the address and the session are what the last run left.
import {
  appInfo, createClient, requestReset, saveMySettings, signIn as signInRow, signOut as signOutRow, type ApiClient,
} from '@bw/api';
import { chooseLanguage, type Language } from '@bw/i18n/src/language.ts';
import {
  FileItemStore, NotReadyError, SYNC_CALL_LIMIT_MS, TechOutbox, uploadLimitMs, type AnsweredItem, type EntryInput, type FinishPayload, type OutboxState, type QueuedItem, type StoreDir,
} from '@bw/outbox/src/items/native.ts';
import type { Instant } from '@bw/time';
import { SessionStore, type SecretStore, type Session } from './auth/session-store.ts';
import { parseOrigin } from './net/origin.ts';
import { checkServer, type ServerCheck } from './net/server-check.ts';
import { nativeTransport, type UploadPort } from './net/transport.ts';
import { JobCopies } from './screens/job/copies.ts';
import { KeptRecords } from './screens/mapme/reads.ts';
import { PersonFile } from './screens/today/person.ts';
import { SettingsFile } from './store/settings.ts';

export interface NativeDeps {
  itemsDir: StoreDir;
  settingsDir: StoreDir;
  /** bw-jobs: the job screens' copies of the signed-in person (screens/job/copies.ts), which end with the session (F-1090). */
  jobsDir: StoreDir;
  /** bw-mapme: the Map, Parts and Me copies of the signed-in person (screens/mapme/reads.ts), which end with the session (F-1103). */
  mapmeDir: StoreDir;
  /** bw-person: who the phone last signed in, kept only while items wait (UD-20; F-1115). */
  personDir: StoreDir;
  secrets: SecretStore;
  upload: UploadPort;
  fetch: typeof fetch;
  /** realNow('device_stamp'). */
  deviceNow: () => Instant;
  /** realNow('tech_waiting_banner'). */
  bannerNow: () => number;
  uuid: () => string;
  /** The phone's language tag, for the native rule "profile after sign-in, device language before". */
  deviceLanguage: string | null;
  /** The device name the sync report carries (API-162 device). */
  device: string;
  /** The UI test launch only (-bwLook with -bwServer <origin>): the server the run points the app at, as if SCR-TEC-12 had saved it. */
  serverOverride?: string | null;
}

export type SignInResult = { ok: true } | { ok: false; code: 'credentials_invalid' | 'account_turned_off' | 'unreachable' | 'failed' };
/**
 * `damaged`: only items the phone cannot read are left (F-1093, owner ruling "Allow sign-out, warn"): the screen warns that they are lost
 * and asks again with `discardDamaged`; readable waiting items still refuse the sign-out (UD-20).
 */
export type SignOutResult = { ok: true } | { ok: false; waiting: number; damaged: boolean };
/**
 * SCR-EML-03 (API-165): the reset email was put in the on-screen inbox, with its one-time link (an absolute address on this app's server), or
 * why not. `bad`: the server refused the address (validation_failed); `not_available`: reset protection, or the server refused before the
 * access code (CTL-EML-03-02 "access_code_required (native): the not-available result"); `unreachable`: no answer at all.
 */
export type ResetResult =
  | { ok: true; link: string | null }
  | { ok: false; code: 'no_account' | 'turned_off' | 'not_available' | 'bad' | 'limited' | 'failed' | 'unreachable' };
/**
 * F-1368: how long Sign out waits for the server's API-06 answer before it clears the phone's session anyway (CTL-TEC-10-04). Under the
 * 5 s the owner's case is held to (P6-BUILD5-FIXES), with room for the tap and the screen change.
 */
export const SIGN_OUT_WAIT_MS = 3_000;
export type SaveServerResult ={ ok: true } | { ok: false; waiting: number; damaged: boolean };

export interface AppState {
  ready: boolean;
  server: string;
  session: Session | null;
  language: Language;
  outbox: OutboxState;
  /** F-985: the keys of waiting items whose file no longer parses (FileItemStore.damaged): still on the phone, never sent. */
  damaged: string[];
}

/** F-985: what the phone still holds unsent, the number in the waiting count and on the Waiting to send screen (SCR-TEC-09): the readable items and the damaged ones. */
export const waitingTotal = (s: Pick<AppState, 'outbox' | 'damaged'>): number => s.outbox.waiting.length + s.damaged.length;

/**
 * A fetch whose every rejection is a TypeError: a rejected fetch had no HTTP answer, which the shared engine reads as "no signal"
 * (wire.ts failureOf). React Native 0.88's fetch can reject with a plain Error (P6-NATIVE-JOB: with the relay cut, the engine read it as
 * a server error and never showed No signal, CTL-CMP-10-01).
 */
export function answeredOrNetwork(f: typeof fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    try {
      return await f(input, init);
    } catch (e) {
      throw e instanceof TypeError ? e : new TypeError(`Network request failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }) as typeof fetch;
}

const IDLE_OUTBOX: OutboxState = { ready: false, waiting: [], online: true, sending: false, oldCount: 0, lastSent: [], signedOut: false };

export class NativeApp {
  readonly store: FileItemStore;
  private readonly settings: SettingsFile;
  private readonly sessions: SessionStore;
  private engine: TechOutbox | null = null;
  private engineOff: (() => void) | null = null;
  private state: AppState;
  private readonly listeners = new Set<(s: AppState) => void>();

  private readonly deps: NativeDeps;
  /** The person's job copies, made with the app (not with the first job screen) so every end of the session clears them (F-1090). */
  readonly jobCopies: JobCopies;
  /** Who the phone last signed in (SCR-TEC-01 Items waiting); the file goes when nothing waits (F-1115). */
  readonly person: PersonFile;

  constructor(deps: NativeDeps) {
    this.deps = deps;
    this.store = new FileItemStore(deps.itemsDir);
    this.jobCopies = new JobCopies(deps.jobsDir);
    this.person = new PersonFile(deps.personDir);
    this.settings = new SettingsFile(deps.settingsDir);
    this.sessions = new SessionStore(deps.secrets);
    const forced = deps.serverOverride ? parseOrigin(deps.serverOverride) : null;
    if (forced) this.settings.write({ server: forced });
    const saved = this.settings.read();
    this.state = { ready: false, server: saved.server, session: null, language: this.pickLanguage(null), outbox: IDLE_OUTBOX, damaged: [] };
  }

  get snapshot(): AppState {
    return this.state;
  }

  subscribe(fn: (s: AppState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(patch: Partial<AppState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn(this.state);
  }

  private pickLanguage(session: Session | null): Language {
    const chosen = this.settings.read().language;
    if (!session && chosen) return chosen;
    return chooseLanguage('native', { profile: session?.language, device: this.deps.deviceLanguage });
  }

  /** The open: the session this server's Keychain entry holds, then a send of whatever waits (SD-47 "on open"). */
  async open(): Promise<void> {
    // F-987: iOS keeps Keychain items when the app is deleted; with no first-run marker this install is new, so no session carries over.
    if (!this.settings.read().opened) {
      await this.sessions.clear();
      this.settings.write({ opened: true });
    }
    const session = await this.sessions.load(this.state.server);
    this.set({ session, language: this.pickLanguage(session) });
    if (session) await this.startEngine(session);
    else await this.refreshSignedOut();
    this.set({ ready: true });
    void this.sync();
  }

  /** The waiting items read straight from the store while signed out (the sign-in screen's Items waiting state). */
  private async refreshSignedOut(): Promise<void> {
    const waiting = await this.store.waiting();
    const damaged = this.store.damaged();
    // The sign-in screen locks the name to the waiting technician (UD-20), so the name is kept only while something waits (F-1115).
    if (waiting.length === 0 && damaged.length === 0) this.person.clear();
    this.set({ outbox: { ...IDLE_OUTBOX, ready: true, waiting }, damaged });
  }

  /**
   * `signal`: every request this client makes is cancelled with it (the sign-out's time limit, F-1368). `timeoutMs`: each call's own time
   * limit (F-1746: the engine's sync calls).
   */
  private client(session: Session | null, signal?: AbortSignal, timeoutMs?: number): ApiClient {
    const f = this.deps.fetch;
    const send: typeof fetch = signal ? (input, init) => f(input, { ...init, signal }) : f;
    return createClient({
      baseUrl: this.state.server, fetch: answeredOrNetwork(send), ...(session ? { headers: { authorization: `Bearer ${session.token}` } } : {}), ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
  }

  /** Starts the engine and reads the store before anything else (F-984: the header shows no count until outbox.ready). */
  private async startEngine(session: Session): Promise<void> {
    this.engineOff?.();
    // F-1746: the sync's reads (API-07, API-162, API-10) have a time limit; the items go by background uploads, which have their own.
    const client = this.client(session, undefined, SYNC_CALL_LIMIT_MS);
    const engine = new TechOutbox({
      store: this.store,
      transport: nativeTransport({ origin: session.origin, token: session.token, blobUri: (k) => this.store.blobUri(k), port: this.deps.upload, limitMs: uploadLimitMs }),
      client,
      deviceNow: this.deps.deviceNow,
      bannerNow: this.deps.bannerNow,
      // No reachability service: the engine learns "no signal" from a call that fails for the network, and the triggers retry.
      isOnline: () => true,
      device: this.deps.device,
      app: 'native',
      uuid: this.deps.uuid,
    });
    this.engine = engine;
    this.engineOff = engine.subscribe((outbox) => {
      this.set({ outbox, damaged: this.store.damaged() });
      // A 401 ended the session on the server: the Keychain entry goes and the sign-in screen opens; every item still waits (I2).
      if (outbox.signedOut && this.state.session) void this.endSession();
    });
    void client.call(appInfo, {}).then((r) => engine.setVersion(r.data.sourceCommit), () => undefined);
    await engine.refresh();
  }

  /** A read answered 401 (the Map, Parts and Me reads): the server ended this session, so the Keychain entry goes and the sign-in screen opens. */
  async sessionRefused(): Promise<void> {
    if (this.state.session) await this.endSession();
  }

  private async endSession(): Promise<void> {
    this.engineOff?.();
    this.engineOff = null;
    this.engine = null;
    await this.sessions.clear();
    // Sign out, a 401 the engine met, or a read's 401 (sessionRefused): the person's copies go with the session, whichever screen was used.
    this.jobCopies.forgetAll();
    KeptRecords.forgetAll(this.deps.mapmeDir); // F-1103: a 401 before any Map, Parts or Me screen opened leaves no lifecycle to clear them
    this.set({ session: null, language: this.pickLanguage(null) });
    await this.refreshSignedOut();
  }

  /** 1 send (SD-47 triggers: open, focus, after each entry, every 60 s). Signed out, it only re-reads the store. */
  async sync(): Promise<void> {
    if (this.engine) await this.engine.sync();
    else await this.refreshSignedOut();
  }

  /** Section 5.1 step 1 through the shared engine: resolves once the store holds the item (I1). */
  async enter(input: EntryInput): Promise<QueuedItem> {
    if (!this.engine) throw new NotReadyError('no_user');
    return this.engine.enter(input);
  }

  // ---- the job screens' reads and writes (P6-NATIVE-JOB) ----------------------------------------------------------------------

  /** The typed client with this session's bearer token, or null signed out (API-07, API-101, API-104, API-107). */
  api(): ApiClient | null {
    return this.state.session ? this.client(this.state.session) : null;
  }

  /** The session's bearer header, for an image the server answers (API-175), or null signed out. */
  authHeader(): Record<string, string> | null {
    return this.state.session ? { authorization: `Bearer ${this.state.session.token}` } : null;
  }

  /** The demo time now by the clock offset the store keeps (null before the first clock read). */
  demoNowMs(): Promise<number | null> {
    return this.engine ? this.engine.demoNowMs() : Promise.resolve(null);
  }

  /** The answered items the store keeps, newest first; the Waiting to send screen (SCR-TEC-09) lists those flagged, history only, or not added after a reset. */
  answered(): Promise<AnsweredItem[]> {
    return this.engine ? this.engine.answered() : this.store.answered();
  }

  /** F-1025: a refused finish corrected under its own key (CTL-TEC-07-08). */
  correctFinish(key: string, payload: FinishPayload): Promise<QueuedItem> {
    if (!this.engine) throw new NotReadyError('no_user');
    return this.engine.correctFinish(key, payload);
  }

  // ---- checking and saving the server address on its screen (SCR-TEC-12) -----------------------------------------------------------------------------------------

  check(origin: string): Promise<ServerCheck> {
    return checkServer(origin, this.deps.fetch);
  }

  /** CTL-TEC-12-04 Save: only signed out (CTL-TEC-01-06 opens SCR-TEC-12 from the sign-in screen), only a checked origin. */
  saveServer(origin: string): Promise<SaveServerResult> {
    if (this.state.session) throw new Error('saveServer: sign out to change the server');
    return this.saveServerChecked(origin);
  }

  /** F-986: items carry the old server's user id and never send elsewhere, so the address stays while any item waits (UD-20). */
  private async saveServerChecked(origin: string): Promise<SaveServerResult> {
    const held = await this.held();
    if (held.total > 0) return { ok: false, waiting: held.total, damaged: held.readable === 0 };
    this.settings.write({ server: origin });
    this.set({ server: origin });
    return { ok: true };
  }

  /** F-985: an item whose file no longer parses still sits on the phone, so it counts as waiting here. */
  private async held(): Promise<{ readable: number; total: number }> {
    const readable = (await this.store.waiting()).length;
    return { readable, total: readable + this.store.damaged().length };
  }

  // ---- session -------------------------------------------------------------------------------------------------------------

  async signIn(login: string, password: string, staySignedIn: boolean): Promise<SignInResult> {
    let r;
    try {
      r = await this.client(null).call(signInRow, { login, password, client: 'native', keepSignedIn: staySignedIn });
    } catch (e) {
      const code = (e as { problem?: { code?: string } }).problem?.code;
      if (code === 'credentials_invalid' || code === 'account_turned_off') return { ok: false, code };
      // an answer that is a Problem is the server's; only a rejected fetch (a TypeError, see answeredOrNetwork) is no server at all: an answer
      // that does not parse (a contract drift) must not send the person to change the server address (F-1109)
      return { ok: false, code: e instanceof TypeError ? 'unreachable' : 'failed' };
    }
    if (!r.data.token) return { ok: false, code: 'failed' };
    const u = r.data.user;
    const session: Session = { origin: this.state.server, token: r.data.token, userId: u.id, name: u.name, language: u.language, staySignedIn };
    await this.sessions.save(session);
    this.set({ session, language: this.pickLanguage(session) });
    await this.startEngine(session);
    void this.sync();
    return { ok: true };
  }

  /** SCR-EML-03 Send reset email (CTL-EML-03-02): API-165 for the technician app, signed out. */
  async requestReset(email: string): Promise<ResetResult> {
    let r;
    try {
      r = await this.client(null).call(requestReset, { email, app: 'tech' });
    } catch (e) {
      const code = (e as { problem?: { code?: string } }).problem?.code;
      if (code === 'validation_failed') return { ok: false, code: 'bad' };
      if (code === 'rate_limited') return { ok: false, code: 'limited' };
      if (code === 'access_code_required') return { ok: false, code: 'not_available' };
      return { ok: false, code: e instanceof TypeError ? 'unreachable' : 'failed' };
    }
    const d = r.data;
    if (d.sent) return { ok: true, link: d.emailLink === null ? null : new URL(d.emailLink, this.state.server).toString() };
    return { ok: false, code: d.reason === 'no_account' ? 'no_account' : d.reason === 'account_turned_off' ? 'turned_off' : 'not_available' };
  }

  /**
   * CTL-TEC-10-04: refused while items wait (UD-20); offline with nothing waiting, the local session is cleared anyway. F-1093 (owner ruling
   * "Allow sign-out, warn"): when only items the phone cannot read remain, the sign-out is refused once with `damaged` so the screen can warn
   * that they are lost; a second call with `discardDamaged` deletes them and signs out.
   */
  async signOut(discardDamaged = false): Promise<SignOutResult> {
    const held = await this.held();
    if (held.readable > 0 || (held.total > 0 && !discardDamaged)) return { ok: false, waiting: held.total, damaged: held.readable === 0 };
    if (held.total > 0) this.store.discardDamaged();
    const s = this.state.session;
    if (s) await this.tellServerSignedOut(s);
    await this.endSession();
    return { ok: true };
  }

  /**
   * F-1368 (CTL-TEC-10-04 "the local session is cleared anyway"): API-06 is sent, but waited for at most SIGN_OUT_WAIT_MS. A server that
   * accepts the connection and never answers (a deleted copy behind a live address; iOS then waits for the connection for days) must not
   * keep the phone signed in. Past the limit the request is cancelled and the sign-out goes on; an answer, a refusal or no answer at all
   * changes nothing on the phone.
   */
  private async tellServerSignedOut(s: Session): Promise<void> {
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        ctl.abort();
        resolve();
      }, SIGN_OUT_WAIT_MS);
    });
    const sent = this.client(s, ctl.signal).call(signOutRow, {}).then(() => undefined, () => undefined);
    try {
      // the race, not the abort, is the bound: a fetch that ignores its signal still cannot hold the sign-out
      await Promise.race([sent, limit]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** CTL-CMP-03-01: re-renders in place; signed in it is saved to the profile (API-08), signed out it is kept on the phone. */
  async setLanguage(language: Language): Promise<void> {
    this.set({ language });
    const s = this.state.session;
    if (!s) {
      this.settings.write({ language });
      return;
    }
    const next = { ...s, language };
    await this.sessions.save(next);
    this.set({ session: next });
    await this.client(s).call(saveMySettings, { language }).catch(() => undefined);
  }
}
