// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-AUTH-9, FR-AUTH-8, FR-IOS-4
// SCR-EML-03 Forgot password on the phone (F-1107): the controller's API-165 call (core.ts requestReset) against a scripted server, and the
// screen's rules (forgot-model.ts). The real-path proof is TodayUITests test1 on the simulator against the Compose stack.
import { problemType } from '@bw/api';
import { describe, expect, it } from 'vitest';
import { Temporal } from '@bw/time';
import { NativeApp } from '../core.ts';
import { memoryKeychain, nodeDir } from '../testing.ts';
import { EMAIL, forgotStateOf, openLinkOnce, RESULT } from './forgot-model.ts';

const SERVER = 'http://192.168.1.20:8080';
const meta = { contract: 'API-165', worldEpoch: 1, demoNow: '2026-09-15T10:28:00-04:00[America/New_York]', viewer: { kind: 'public' }, labels: [] };

/** A phone whose server answers API-165 with `answer` (status, body) and records what it was asked. */
function phone(answer: (body: { email: string; app: string }) => { status: number; body: unknown } | Error) {
  const asked: { url: string; body: { email: string; app: string }; auth: string | null }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body)) as { email: string; app: string };
    asked.push({ url: String(input), body, auth: ((init?.headers ?? {}) as Record<string, string>)['authorization'] ?? null });
    const a = answer(body);
    if (a instanceof Error) throw a;
    return new Response(JSON.stringify(a.body), { status: a.status });
  };
  const app = new NativeApp({
    itemsDir: nodeDir(), settingsDir: nodeDir(), jobsDir: nodeDir(), mapmeDir: nodeDir(), personDir: nodeDir(), secrets: memoryKeychain(), fetch,
    upload: { upload: () => Promise.reject(new Error('no upload')), bodyFile: () => ({ uri: 'file:///x', done: () => undefined }) },
    deviceNow: () => Temporal.Instant.from('2026-11-08T15:30:00Z'), bannerNow: () => 0, uuid: () => '00000000-0000-4000-8000-000000000001',
    deviceLanguage: 'en-US', device: 'iPhone app (test)', serverOverride: SERVER,
  });
  return { app, asked };
}

const answered = (data: unknown) => ({ status: 202, body: { data, meta } });
const problem = (code: string, status: number) => ({ status, body: { type: problemType(code as never), title: 'x', status, code, meta } });

describe('SCR-EML-03 Forgot password (native)', () => {
  // why: FR-AUTH-9, FR-AUTH-8 Send reset email asks API-165 for the technician app, signed out, and a sent email's one-time link is made an address on the app's own server, opened from there
  it('asks for the technician app with no session and answers the link on the app\'s server', async () => {
    const p = phone(() => answered({ sent: true, reason: null, emailLink: '/email/abc' }));
    const r = await p.app.requestReset('maria.santos@brightwater.example');
    expect(r).toEqual({ ok: true, link: `${SERVER}/email/abc` });
    expect(p.asked).toEqual([{ url: `${SERVER}/api/v1/password-resets`, body: { email: 'maria.santos@brightwater.example', app: 'tech' }, auth: null }]);
    expect(forgotStateOf(r)).toEqual({ state: 'sent', bad: false, link: `${SERVER}/email/abc` });
  });

  // why: FR-AUTH-9, FR-IOS-4 each answer that sends nothing shows its own result (no account, turned off, reset protection on), a server that refuses the phone before the access code shows Not available, and none of them offers a link
  it('reads each refusal as its result, the access code refusal as Not available', async () => {
    const cases: [ReturnType<typeof answered> | ReturnType<typeof problem>, string][] = [
      [answered({ sent: false, reason: 'no_account', emailLink: null }), 'no_account'],
      [answered({ sent: false, reason: 'account_turned_off', emailLink: null }), 'turned_off'],
      [answered({ sent: false, reason: 'protection_on', emailLink: null }), 'not_available'],
      [problem('access_code_required', 403), 'not_available'],
      [problem('rate_limited', 429), 'limited'],
      [problem('server_error', 500), 'failed'],
    ];
    for (const [a, state] of cases) {
      const r = await phone(() => a).app.requestReset('x@brightwater.example');
      expect(forgotStateOf(r), state).toEqual({ state, bad: false, link: null });
      expect(RESULT[forgotStateOf(r).state]?.key, state).toBeDefined();
    }
  });

  // why: FR-AUTH-9 an address the server refuses as not an email shows the field message again, and a phone with no signal says the request did not go through
  it('shows the field message for validation_failed and the failed result with no answer', async () => {
    expect(forgotStateOf(await phone(() => problem('validation_failed', 422)).app.requestReset('x@y.z'))).toEqual({ state: 'default', bad: true, link: null });
    expect(forgotStateOf(await phone(() => new TypeError('Network request failed')).app.requestReset('x@y.z'))).toEqual({ state: 'failed', bad: false, link: null });
    expect(EMAIL.test('not-an-address')).toBe(false);
    expect(EMAIL.test('maria.santos@brightwater.example')).toBe(true);
    expect(EMAIL.test('a b@c.d')).toBe(false);
  });

  // why: F-1119 CTL-EML-03-04 the one-time link is used only when the in-app browser says the page is on screen; a false answer or a rejection keeps it for another try
  it('counts the link as opened only when the browser answers true', async () => {
    expect(await openLinkOnce('https://x/y', async () => true)).toBe('opened');
    expect(await openLinkOnce('https://x/y', async () => false)).toBe('failed');
    expect(await openLinkOnce('https://x/y', async () => { throw new Error('no screen'); })).toBe('failed');
  });

  // why: F-1109 (c) an answer that does not match the contract is a failed request, never "no answer", which sends the person to the server address
  it('reads a 200 that does not parse as failed, not unreachable', async () => {
    expect(await phone(() => ({ status: 200, body: { nonsense: true } })).app.requestReset('x@y.z')).toEqual({ ok: false, code: 'failed' });
  });
});
