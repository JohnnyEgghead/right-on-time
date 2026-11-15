// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: tooling
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Browser } from 'playwright';
import { engines } from '../pw-engines.ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compareLook, formatDifferences } from './compare.ts';
import { FRAME, KNOWN_BAD_PAIRS, writeKnownBad } from './known-bad.ts';

// Browser proofs of the comparator on Chromium and WebKit. Run by ci/gates/look-values-comparator.sh through
// vitest.browser.config.ts; the unit-tests gate excludes *.pw.test.ts. The browser-free compareKitSheets test
// is kit-sheets.test.ts.
const SCREEN_BUDGET_S = 30;
const frameUrl = pathToFileURL(path.resolve(FRAME)).href;
// The engine list comes from ci/pw-engines.ts: a narrowed run must name why and prints a DROPPED notice (F-39).

describe.each(engines)('compareLook on %s', (engine, type) => {
  let browser: Browser | undefined;
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'look-values-test-'));
    browser = await type.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('passes the frame page compared with itself', async () => {
    // reason: acceptance 2 of G-LOOK-PARITY; a comparator that flags identical pages is noise
    const r = await compareLook({
      appUrl: frameUrl,
      framePath: FRAME,
      pairs: KNOWN_BAD_PAIRS,
      browser: browser!,
    });
    expect(r.differences).toEqual([]);
    console.log(`screen-seconds ${engine} ${FRAME} self-compare ${r.seconds}`);
    expect(r.seconds).toBeLessThanOrEqual(SCREEN_BUDGET_S);
  }, 60_000);

  it('flags the known-bad fixture, naming the padding and the color property', async () => {
    // reason: acceptance 1 of G-LOOK-PARITY; proves the gate can fail on a known-bad
    const bad = path.join(dir, 'bad.html');
    writeKnownBad(bad);
    const r = await compareLook({
      appUrl: pathToFileURL(bad).href,
      framePath: FRAME,
      pairs: KNOWN_BAD_PAIRS,
      browser: browser!,
    });
    const props = r.differences.map((d) => `${d.pair} ${d.property}`);
    expect(props).toContain('.btn.sm padding-left');
    expect(props).toContain('.btn.sm padding-right');
    expect(props).toContain('.btn.primary color');
    // the untouched element reports nothing
    expect(props.filter((p) => p.startsWith('.topbar'))).toEqual([]);
    expect(formatDifferences(r)).toContain('FAIL');
    console.log(`screen-seconds ${engine} ${FRAME} known-bad ${r.seconds}`);
    expect(r.seconds).toBeLessThanOrEqual(SCREEN_BUDGET_S);
  }, 60_000);

  it('reports a selector missing on one side as a difference, not a pass', async () => {
    // reason: a typo in a selector pair must not silently compare nothing
    const r = await compareLook({
      appUrl: frameUrl,
      framePath: FRAME,
      pairs: [{ app: '.no-such-element-xyz' }],
      browser: browser!,
    });
    expect(r.differences).toHaveLength(1);
    expect(r.differences[0]?.property).toBe('element');
  }, 60_000);

  it('compares colors as values, with no contrast threshold', async () => {
    // reason: OA-84 and D-5, contrast is not a gate; a 1-step color change is flagged and a near-contrast one is not special
    const bad = path.join(dir, 'bad2.html');
    writeKnownBad(bad);
    const r = await compareLook({
      appUrl: pathToFileURL(bad).href,
      framePath: FRAME,
      pairs: [{ app: '.btn.primary' }],
      browser: browser!,
    });
    // every match of the selector is read now (F-34), so .btn.sm.primary matches add the padding change as well
    const color = r.differences.filter((d) => d.property === 'color');
    expect(color.length).toBeGreaterThan(0);
    expect(color[0]?.app).toBe('rgb(254, 254, 254)');
  }, 60_000);

  // Writes a copy of the frame page with one string edit, so a planted change cannot drift from the frame.
  const plant = (name: string, edit: (html: string) => string) => {
    const f = path.join(dir, name);
    writeFileSync(f, edit(readFileSync(FRAME, 'utf8')));
    return pathToFileURL(f).href;
  };

  it('flags a change on the 2nd match of a selector, not only the 1st', async () => {
    // reason: F-34; a selector pair used to compare only the first match
    const url = plant('second.html', (h) => {
      const mark = 'class="btn sm"';
      const first = h.indexOf(mark);
      const second = h.indexOf(mark, first + 1);
      return h.slice(0, second) + 'class="btn sm" style="padding:0 12px"' + h.slice(second + mark.length);
    });
    const r = await compareLook({ appUrl: url, framePath: FRAME, pairs: [{ app: '.btn.sm' }], browser: browser! });
    const hit = r.differences.filter((d) => d.property === 'padding-left');
    // the 1st match is untouched, so a first-match-only read would have passed
    expect(hit.length).toBeGreaterThan(0);
    expect(hit.every((d) => d.index !== undefined && d.index > 0)).toBe(true);
    expect(formatDifferences(r)).toMatch(/DIFF \.btn\.sm\[[1-9]\d*\] padding-left/);
  }, 60_000);

  it('flags a different match count', async () => {
    // reason: F-34; an extra element matching the selector is a difference, not a pass
    const url = plant('count.html', (h) => h.replace('</body>', '<button class="btn sm">x</button></body>'));
    const r = await compareLook({ appUrl: url, framePath: FRAME, pairs: [{ app: '.btn.sm' }], browser: browser! });
    const el = r.differences.find((d) => d.property === 'element');
    const [a, f] = [el?.app, el?.frame].map((v) => Number(/^(\d+) match/.exec(v ?? '')?.[1]));
    expect(a).toBe(f! + 1);
  }, 60_000);

  it('flags a gradient background change (background-image)', async () => {
    // reason: F-33; kit.css draws 9 backgrounds as gradients, and background-color alone does not see them
    const url = plant('gradient.html', (h) => h.replace('#f5f6f8 8px 16px', '#f5f6f7 8px 16px'));
    const r = await compareLook({ appUrl: url, framePath: FRAME, pairs: [{ app: '.tl-row.unas' }], browser: browser! });
    expect(r.differences.map((d) => d.property)).toContain('background-image');
  }, 60_000);

  it('reports an invalid selector as a difference, not a stack trace', async () => {
    // reason: F-35; a selector the browser rejects must come back as a reported difference
    const r = await compareLook({ appUrl: frameUrl, framePath: FRAME, pairs: [{ app: ':::bad' }], browser: browser! });
    expect(r.differences).toHaveLength(1);
    expect(r.differences[0]?.app).toContain('invalid selector');
  }, 60_000);

  it('fails when an app page requests another origin (outside-origin guard)', async () => {
    // reason: F-36 and F-40; the comparator opens its context through guardedContext
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><body><img src="https://example.com/x.png"></body>');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const appUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
      await expect(
        compareLook({ appUrl, framePath: FRAME, pairs: [{ app: 'body' }], browser: browser! }),
      ).rejects.toThrow(/outside-origin-guard.*example\.com/);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 60_000);
});

describe('look-values cli', () => {
  it('compares an element picked by an attribute selector (the = in it is not a separator)', () => {
    // reason: F-35; --pair used to split on the first =, which cut every data-ctl selector in two
    const r = spawnSync(
      'node',
      ['ci/look-values/cli.ts', '--app', frameUrl, '--frame', FRAME, '--pair', '[data-ctl="CTL-OFC-02-22"]'],
      { encoding: 'utf8' },
    );
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain('PASS 1 pair(s), 0 difference(s)');
    expect(r.status).toBe(0);
  }, 60_000);
});
