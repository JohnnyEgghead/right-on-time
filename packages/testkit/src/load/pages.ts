// SPDX-License-Identifier: AGPL-3.0-or-later
// The page load instrument (NFR-02; P7-LOAD): office pages loaded in a real browser on the office network profile, beside the load day's own
// traffic. Each cycle opens a fresh browser context (nothing cached) signed in as 1 dispatcher, throttles it to the profile through
// the DevTools protocol (Network.emulateNetworkConditions), loads the next office page (cold), then the same page again (warm), and
// reads the page's own navigation timing: navigation start to loadEventEnd. The profile's 20 ms round trip is the real one to the
// server plus an added latency, so a path already slower than 20 ms is measured as it is (never faster than the profile).
// The server's self-signed certificate is trusted by its key (--ignore-certificate-errors-spki-list), not by ignoring certificate
// errors: Chromium keeps no HTTP cache for a page with a certificate error, so a warm load would otherwise be a second cold one.
import { createHash, X509Certificate } from 'node:crypto';
import { connect } from 'node:net';
import { chromium, type Browser } from 'playwright';
import { OFFICE_PROFILE, type PageCounts } from './stats.ts';

/** The office pages a dispatcher opens through the day (UI-SPECIFICATION section 6): `{job}` is a load-day job's number. */
export const OFFICE_PAGES: readonly string[] = [
  '/office/board?branch={branch}&date=today',
  '/office/jobs/{job}',
  '/office/board/week?branch={branch}',
  '/office/jobs',
  '/office/messages',
  '/office/messages/call-list',
  '/office/customers',
  '/office/technicians',
];

/** 1 load's own cap: a load slower than this is an error, not a sample. */
const LOAD_TIMEOUT_MS = 30_000;

/** Chromium's --ignore-certificate-errors-spki-list value: base64 of the SHA-256 of the certificate's SubjectPublicKeyInfo. */
export function spkiHash(pem: string): string {
  const der = new X509Certificate(pem).publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('base64');
}

/** The profile's added latency: the 20 ms round trip less the real one, never below 0. */
export const addedLatencyMs = (baseRttMs: number): number => Math.max(0, Math.round(OFFICE_PROFILE.rttMs - baseRttMs));

/** The real round trip to the server: the median TCP connect time of 7 connects to its port 443. */
export async function baseRttMs(host: string, port = 443): Promise<number> {
  const times: number[] = [];
  for (let i = 0; i < 7; i++) {
    times.push(await new Promise<number>((resolve, reject) => {
      const t0 = performance.now();
      const s = connect({ host, port }, () => {
        resolve(performance.now() - t0);
        s.destroy();
      });
      s.setTimeout(5_000, () => s.destroy(new Error('connect timed out')));
      s.on('error', reject);
    }));
  }
  return times.sort((a, b) => a - b)[3] as number;
}

export interface PageProbeOptions {
  origin: string;
  /** The dispatcher session the pages are opened with. */
  token: string;
  branch: string;
  jobs: readonly number[];
  certPem: string;
  addedLatencyMs: number;
  /** A cycle starts this often (or as soon as the last one ends, if it ran longer). */
  everyMs: number;
  log: (line: string) => void;
}

export interface PageRun extends PageCounts { byPage: Record<string, { cold: number[]; warm: number[] }> }

/** The pages of 1 run, probed until stop() is called; stop() answers what was measured. */
export class PageProber {
  readonly #o: PageProbeOptions;
  #stopped = false;
  #done: Promise<void> | null = null;
  #browser: Browser | null = null;
  readonly #run: PageRun = { coldMs: [], warmMs: [], errors: 0, coldErrors: 0, warmErrors: 0, errorsBy: {}, byPage: {} };

  constructor(o: PageProbeOptions) {
    this.#o = o;
  }

  async start(): Promise<void> {
    this.#browser = await chromium.launch({ args: [`--ignore-certificate-errors-spki-list=${spkiHash(this.#o.certPem)}`] });
    this.#done = this.#loop();
  }

  async stop(): Promise<PageRun> {
    this.#stopped = true;
    await this.#done;
    await this.#browser?.close();
    return this.#run;
  }

  /** F-1494: each failure is counted under its kind too, so NFR-02's cold p95 ranks only the failed cold loads. */
  #error(kind: 'cold' | 'warm', why: string): void {
    this.#run.errors += 1;
    if (kind === 'cold') this.#run.coldErrors = (this.#run.coldErrors ?? 0) + 1;
    else this.#run.warmErrors = (this.#run.warmErrors ?? 0) + 1;
    this.#run.errorsBy[why] = (this.#run.errorsBy[why] ?? 0) + 1;
  }

  async #loop(): Promise<void> {
    let n = 0;
    while (!this.#stopped) {
      const started = performance.now();
      const template = OFFICE_PAGES[n % OFFICE_PAGES.length] as string;
      const job = this.#o.jobs[Math.floor(n / OFFICE_PAGES.length) % this.#o.jobs.length] as number;
      n += 1;
      await this.#cycle(template, template.replace('{branch}', this.#o.branch).replace('{job}', String(job)));
      const wait = this.#o.everyMs - (performance.now() - started);
      if (wait > 0 && !this.#stopped) await new Promise((r) => setTimeout(r, wait));
    }
  }

  async #cycle(template: string, path: string): Promise<void> {
    const browser = this.#browser as Browser;
    const context = await browser.newContext();
    try {
      await context.addCookies([{ name: 'bw_session', value: this.#o.token, url: this.#o.origin, secure: true, httpOnly: true, sameSite: 'Lax' }]);
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      await cdp.send('Network.enable');
      const bytesPerS = (OFFICE_PROFILE.mbps * 1_000_000) / 8;
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: this.#o.addedLatencyMs, downloadThroughput: bytesPerS, uploadThroughput: bytesPerS });
      const by = (this.#run.byPage[template] ??= { cold: [], warm: [] });
      for (const kind of ['cold', 'warm'] as const) {
        let ms: number;
        try {
          const r = await page.goto(`${this.#o.origin}${path}`, { waitUntil: 'load', timeout: LOAD_TIMEOUT_MS });
          if (!r || r.status() !== 200) {
            this.#error(kind, `${template} ${kind}: ${r ? r.status() : 'no response'}`);
            return;
          }
          // A session the server did not take lands on the sign-in page with a 200: that is a failed load, not a fast one.
          if (new URL(page.url()).pathname !== new URL(`${this.#o.origin}${path}`).pathname) {
            this.#error(kind, `${template} ${kind}: landed on ${new URL(page.url()).pathname}`);
            return;
          }
          // loadEventEnd is set once the load handlers return, which can be just after goto resolves on the load event.
          // Page-side code as strings: this package compiles without the DOM types.
          await page.waitForFunction(`(performance.getEntriesByType('navigation')[0]?.loadEventEnd ?? 0) > 0`, undefined, { timeout: LOAD_TIMEOUT_MS });
          ms = await page.evaluate<number>(`(() => { const n = performance.getEntriesByType('navigation')[0]; return n.loadEventEnd - n.startTime; })()`);
        } catch (e) {
          this.#error(kind, `${template} ${kind}: ${(e as Error).name === 'TimeoutError' ? 'timed out' : (e as Error).message.split('\n')[0]!.slice(0, 80)}`);
          return;
        }
        (kind === 'cold' ? (this.#run.coldMs as number[]) : (this.#run.warmMs as number[])).push(ms);
        by[kind].push(ms);
      }
    } finally {
      await context.close();
    }
  }
}
