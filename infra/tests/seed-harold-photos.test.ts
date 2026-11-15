// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-TECH-6, NFR-05, NFR-14 (P6-TESTFLIGHT-4, F-1350: the staging step that puts session step 5's 3 photos on Harold Jenkins's job through the copy's own API; offline, with a stubbed fetch)
// The script's calls are checked against a stub of the copy, and the photo sender (seed-photos.mjs) is a stub that adds the photos it is
// handed: no address is opened. Only the last block (F-1370, macOS only) makes real pictures, with the script's own makePhotos.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FetchFn } from '../deploy/staging/add-live-job.ts';
import {
  fieldColor, makePhotos, MARIA_LOGIN, MAX_PHOTOS, OFFICE_LOGIN, parseCount, PHOTO_H, PHOTO_W, PHOTOS, photoSvg, SeedRefused, seedHaroldPhotos, utcWire, type Deps,
} from '../deploy/staging/seed-harold-photos.ts';

const SERVER = 'https://203-0-113-9.sslip.io';
const PW = { mariaPassword: 'm'.repeat(20), officePassword: 'o'.repeat(20) };
const TOKENS: Record<string, string> = { [MARIA_LOGIN]: 'M'.repeat(16), [OFFICE_LOGIN]: 'O'.repeat(16) };
const REAL_NOW = '2026-11-10T10:00:05.123-05:00[America/New_York]';
interface Call { url: string; method: string; path: string; cookie: string | undefined; body: string | undefined }

/** The copy: Maria's Sep 15 on the board, Harold's 24830 holding `photos`, then Linda Miller's 24828 as the phone's next job. */
function copy(state: { photos: number }, calls: Call[]): FetchFn {
  const reply = (status: number, data: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify({ data }), { status, headers });
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const p = String(input).slice(`${SERVER}/api/v1`.length);
    const h = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url: String(input), method: init?.method ?? 'GET', path: p, cookie: h.cookie, body: init?.body ? String(init.body) : undefined });
    if (p === '/sessions') {
      const b = JSON.parse(String(init?.body));
      const ok = (b.login === MARIA_LOGIN && b.password === PW.mariaPassword) || (b.login === OFFICE_LOGIN && b.password === PW.officePassword);
      return ok ? new Response('{}', { status: 200, headers: { 'set-cookie': `bw_session=${TOKENS[b.login]}; Path=/; HttpOnly` } }) : new Response('{}', { status: 401 });
    }
    if (p === '/sessions/current') return new Response(null, { status: 204 });
    if (p.startsWith('/board?') && h.cookie === 'bw_session=OOOOOOOOOOOOOOOO') {
      return reply(200, { technicians: [{ id: 't-maria', name: 'Maria Santos', jobs: [{ jobNumber: 24825, customerName: 'Diego Vargas' }, { jobNumber: 24830, customerName: 'Harold Jenkins' }] }] });
    }
    if (p === '/clock' && h.cookie === 'bw_session=OOOOOOOOOOOOOOOO') return reply(200, { realNow: REAL_NOW, demoNow: '2026-09-15T09:40:00-04:00[America/New_York]', worldEpoch: 1 });
    if (p === '/tech/jobs/24830' && h.cookie === 'bw_session=MMMMMMMMMMMMMMMM') {
      return reply(200, { job: { jobNumber: 24830, nextJob: 24828 }, customer: { name: 'Harold Jenkins' }, photos: Array.from({ length: state.photos }, (_, i) => ({ key: `k${i}` })) });
    }
    if (p === '/tech/jobs/24828' && h.cookie === 'bw_session=MMMMMMMMMMMMMMMM') return reply(200, { job: { jobNumber: 24828, nextJob: 24839 }, customer: { name: 'Linda Miller' }, photos: [] });
    return reply(404, null);
  }) as FetchFn;
}

function deps(state: { photos: number }, calls: Call[], sendStatus = 0) {
  const sends: { args: string[]; env: Record<string, string> }[] = [];
  const made: number[][] = [];
  const lines: string[] = [];
  const d: Deps = {
    fetchFn: copy(state, calls),
    makePhotos: (numbers) => {
      made.push(numbers);
      return numbers.map((k) => `/tmp/seed-${k}.jpg`);
    },
    runSend: (args, env) => {
      sends.push({ args, env });
      if (sendStatus === 0) state.photos += args.length - 4;
      return { status: sendStatus, stdout: args.slice(4).map((_, i) => `key-${i} ${sendStatus === 0 ? 'applied' : 'status 409'}`).join('\n') };
    },
    log: (l) => lines.push(l),
  };
  return { d, sends, made, lines };
}

describe('seed-harold-photos (P6-TESTFLIGHT-4, F-1350)', () => {
  // why: FR-TECH-6 the 3 photos go to Harold's job as Maria's web app sends them, with tokens from the copy's own sign-ins and the copy's own clock
  it("signs in as Maria and the office, finds Harold's job on the board, and sends 3 photos with the copy's realNow in UTC", async () => {
    const state = { photos: 0 };
    const calls: Call[] = [];
    const { d, sends, made } = deps(state, calls);
    const out = await seedHaroldPhotos({ server: SERVER, ...PW }, d);
    expect(out).toEqual({ jobNumber: 24830, sent: 3, photos: 3, nextJob: { jobNumber: 24828, customerName: 'Linda Miller' } });
    expect(made).toEqual([[1, 2, 3]]);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.args.slice(1)).toEqual([SERVER, SERVER, '24830', '/tmp/seed-1.jpg', '/tmp/seed-2.jpg', '/tmp/seed-3.jpg']);
    expect(sends[0]!.args[0]).toMatch(/apps\/tech-native\/xcuitest\/seed-photos\.mjs$/);
    expect(sends[0]!.env).toEqual({ BW_SEED_TOKEN: 'M'.repeat(16), BW_CLOCK_TOKEN: 'O'.repeat(16), BW_REAL_NOW: '2026-11-10T15:00:05+00:00[UTC]' });
    expect(calls.every((c) => c.url.startsWith(`${SERVER}/api/v1/`))).toBe(true);
  });

  // why: NFR-05 NFR-14 a password goes only in its sign-in body and a token only in a cookie and the sender's environment: never an argument or a printed line
  it('keeps every password and token out of the arguments and the printed lines, and signs both sessions out', async () => {
    const calls: Call[] = [];
    const { d, sends, lines } = deps({ photos: 0 }, calls);
    await seedHaroldPhotos({ server: SERVER, ...PW }, d);
    const secrets = [PW.mariaPassword, PW.officePassword, 'M'.repeat(16), 'O'.repeat(16)];
    for (const s of secrets) {
      expect(lines.join('\n'), s).not.toContain(s);
      expect(sends.flatMap((x) => x.args).join(' '), s).not.toContain(s);
    }
    expect(calls.filter((c) => secrets.slice(0, 2).some((s) => c.body?.includes(s))).map((c) => c.path)).toEqual(['/sessions', '/sessions']);
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => [c.path, c.cookie])).toEqual([
      ['/sessions/current', 'bw_session=MMMMMMMMMMMMMMMM'], ['/sessions/current', 'bw_session=OOOOOOOOOOOOOOOO'],
    ]);
  });

  // why: FR-TECH-6 a re-run converges on 3: a job holding 3 gets nothing, a job holding 1 gets the 2 missing
  it('sends only the photos missing on a re-run', async () => {
    const full = deps({ photos: 3 }, []);
    expect(await seedHaroldPhotos({ server: SERVER, ...PW }, full.d)).toMatchObject({ sent: 0, photos: 3 });
    expect(full.sends).toHaveLength(0);
    const part = deps({ photos: 1 }, []);
    expect(await seedHaroldPhotos({ server: SERVER, ...PW }, part.d)).toMatchObject({ sent: 2, photos: 3 });
    expect(part.made).toEqual([[2, 3]]); // labeled on from the photo already there
  });

  // why: FR-TECH-6 a job holding more than the page's 3 is refused, and a send that fails is refused; both sessions are signed out either way
  it('refuses more than 3 photos and a failed send, signing out both sessions', async () => {
    for (const [photos, status, msg] of [[4, 0, /already holds 4 photos/], [0, 1, /seed-photos.mjs exited 1/]] as const) {
      const calls: Call[] = [];
      await expect(seedHaroldPhotos({ server: SERVER, ...PW }, deps({ photos }, calls, status).d)).rejects.toThrow(msg);
      expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(2);
    }
  });

  // why: NFR-14 a wrong password is refused at the sign-in, naming who, never the password
  it('refuses a sign-in the copy answers 401', async () => {
    const err = await seedHaroldPhotos({ server: SERVER, ...PW, officePassword: 'wrong' }, deps({ photos: 0 }, []).d).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SeedRefused);
    expect((err as Error).message).toBe("the office's sign-in answered 401");
  });

  // why: NFR-09 the hosted server stays locked: refused before any call
  it('refuses the hosted server before any call', async () => {
    const calls: Call[] = [];
    await expect(seedHaroldPhotos({ server: 'https://bw.j7l.io', ...PW }, deps({ photos: 0 }, calls).d)).rejects.toThrow(/hosted server/);
    expect(calls).toHaveLength(0);
  });

  // why: FR-DEMO-9 the wire time is the copy's realNow, in the shape seed-photos.mjs itself checks BW_REAL_NOW against
  it("turns realNow in any zone into the wire time seed-photos.mjs accepts", () => {
    const src = readFileSync(path.resolve(import.meta.dirname, '../../apps/tech-native/xcuitest/seed-photos.mjs'), 'utf8');
    const shape = /if \(!(\/\^.*\$\/)\.test\(runTime\)\)/.exec(src)?.[1];
    expect(shape, "seed-photos.mjs's BW_REAL_NOW check").toBeDefined();
    const re = new RegExp(shape!.slice(1, -1));
    for (const [wire, utc] of [[REAL_NOW, '2026-11-10T15:00:05+00:00[UTC]'], ['2026-07-04T23:59:59-04:00[America/New_York]', '2026-07-05T03:59:59+00:00[UTC]'], ['2026-11-10T15:00:00Z[UTC]', '2026-11-10T15:00:00+00:00[UTC]']]) {
      expect(utcWire(wire!)).toBe(utc);
      expect(re.test(utcWire(wire!))).toBe(true);
    }
    expect(() => utcWire('not a time')).toThrow(SeedRefused);
  });
});

describe('F-1370 the seeded photos are labeled pictures, as many as --count says (P6-BUILD5-FIXES)', () => {
  // why: F-1370 the count is a flag, so P6-TESTFLIGHT-5 can seed 1 more photo than the photo row shows; a bad flag is a usage error
  it('reads --count, defaults to 3, refuses anything else', () => {
    expect(parseCount([])).toBe(PHOTOS);
    expect(PHOTOS).toBe(3);
    expect(parseCount(['--count', '7'])).toBe(7);
    for (const bad of [['--count'], ['--count', '0'], ['--count', 'x'], ['--count', String(MAX_PHOTOS + 1)], ['-n', '4'], ['--count', '4', 'extra']]) {
      expect(() => parseCount(bad), bad.join(' ')).toThrow(/^usage/);
    }
  });

  // why: F-1370 with --count n the job converges on n, the missing ones labeled on from those there (no 2 photos share a label)
  it('sends count photos labeled Photo 1 to Photo n, and only the missing ones on a re-run', async () => {
    const fresh = deps({ photos: 0 }, []);
    expect(await seedHaroldPhotos({ server: SERVER, ...PW, count: 5 }, fresh.d)).toMatchObject({ sent: 5, photos: 5 });
    expect(fresh.made).toEqual([[1, 2, 3, 4, 5]]);
    const part = deps({ photos: 2 }, []);
    expect(await seedHaroldPhotos({ server: SERVER, ...PW, count: 5 }, part.d)).toMatchObject({ sent: 3, photos: 5 });
    expect(part.made).toEqual([[3, 4, 5]]);
    await expect(seedHaroldPhotos({ server: SERVER, ...PW, count: 2 }, deps({ photos: 3 }, []).d)).rejects.toThrow(/already holds 3 photos, more than the 2/);
  });

  // why: F-1370 every picture has a field color of its own and its own label in the SVG the renderer draws
  it('gives each photo its own field color and its own label', () => {
    const colors = Array.from({ length: MAX_PHOTOS }, (_, i) => fieldColor(i + 1));
    expect(new Set(colors).size).toBe(MAX_PHOTOS);
    for (const c of colors) expect(c).toMatch(/^#[0-9a-f]{6}$/);
    expect(photoSvg(4)).toContain('>Photo 4</text>');
    expect(photoSvg(4)).toContain(`fill="${fieldColor(4)}"`);
  });
});

// The pictures themselves, made by the script's own makePhotos (rsvg-convert, then sips) and read back by sips as small BMPs. sips is macOS
// only, so on Linux (the CI image) this block is skipped, and reported as skipped: never a pass. On macOS a missing tool is a failure.
const MAC = process.platform === 'darwin';
const SIDE = { w: 120, h: 90 };
/**
 * The tolerance: mean absolute difference per channel (0 to 255) between a seeded JPEG and a fresh PNG render of its own label. Measured
 * Nov 10, 2026: 1.5 to 2.2 for the labeled JPEGs; 71 for the noise pictures sent before (the must-fail probe).
 */
const SAME_WITHIN = 6;
/** 2 different photos differ by at least this much (their fields alone differ by far more). */
const APART_BY = 30;

/** A picture scaled to 120 x 90 by sips, as RGB bytes (sips writes a BITMAPINFOHEADER BMP, 24 or 32 bits, either row order). */
function pixels(file: string, dir: string): Uint8Array {
  const out = path.join(dir, `${path.basename(file)}.bmp`);
  const r = spawnSync('sips', ['-s', 'format', 'bmp', '--resampleHeightWidth', String(SIDE.h), String(SIDE.w), file, '--out', out], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`sips could not read ${file}: ${r.stderr}`);
  const b = readFileSync(out);
  const start = b.readUInt32LE(10);
  const w = b.readInt32LE(18);
  const h = b.readInt32LE(22);
  const bpp = b.readUInt16LE(28);
  if (w !== SIDE.w || Math.abs(h) !== SIDE.h || (bpp !== 24 && bpp !== 32)) throw new Error(`unexpected BMP ${w}x${h} at ${bpp} bits`);
  const stride = Math.ceil((w * bpp) / 32) * 4;
  const rgb = new Uint8Array(w * SIDE.h * 3);
  for (let y = 0; y < SIDE.h; y++) {
    const row = start + (h > 0 ? SIDE.h - 1 - y : y) * stride;
    for (let x = 0; x < w; x++) {
      const p = row + x * (bpp / 8);
      rgb.set([b[p + 2]!, b[p + 1]!, b[p]!], (y * w + x) * 3);
    }
  }
  return rgb;
}

const meanDiff = (a: Uint8Array, b: Uint8Array): number => a.reduce((s, v, i) => s + Math.abs(v - b[i]!), 0) / a.length;
/** The share of pixels that are the label's white. */
const whiteShare = (a: Uint8Array): number => {
  let n = 0;
  for (let i = 0; i < a.length; i += 3) if (a[i]! > 200 && a[i + 1]! > 200 && a[i + 2]! > 200) n++;
  return n / (a.length / 3);
};

/** The acceptance check on what the seed made: n pictures, each its own label's fresh render within SAME_WITHIN, pairwise APART_BY. */
function checkSeeded(files: string[], n: number, dir: string): void {
  expect(files).toHaveLength(n);
  const seeded = files.map((f) => pixels(f, dir));
  seeded.forEach((got, i) => {
    const k = i + 1;
    const svg = path.join(dir, `fresh-${k}.svg`);
    const png = path.join(dir, `fresh-${k}.png`);
    writeFileSync(svg, photoSvg(k));
    expect(spawnSync('rsvg-convert', ['-w', String(PHOTO_W), '-h', String(PHOTO_H), '-o', png, svg]).status, 'rsvg-convert').toBe(0);
    const fresh = pixels(png, dir);
    const share = whiteShare(fresh);
    // measured Nov 10, 2026 at 120 x 90: 5.2% to 5.7% of the pixels are the label's white (Photo 1 to 4); a missing or small label is far under 3%
    expect(share, `Photo ${k}'s label is drawn large`).toBeGreaterThan(0.03);
    expect(share, `Photo ${k}'s field shows`).toBeLessThan(0.5);
    expect(meanDiff(got, fresh), `seeded photo ${k} against a fresh render of "Photo ${k}"`).toBeLessThan(SAME_WITHIN);
  });
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) expect(meanDiff(seeded[i]!, seeded[j]!), `photos ${i + 1} and ${j + 1} differ`).toBeGreaterThan(APART_BY);
  }
}

describe.skipIf(!MAC)('F-1370 the pictures (macOS: rsvg-convert and sips)', () => {
  // why: F-1370 the owner could not tell a drawn photo from a broken one: each seeded JPEG is its own label's picture, and no 2 are alike
  it('makes n labeled pictures, each matching a fresh render of its label, pairwise different, n by the count flag', async () => {
    for (const tool of ['rsvg-convert', 'sips']) expect(spawnSync('which', [tool]).status, `${tool} on this Mac`).toBe(0);
    const dir = mkdtempSync(path.join(tmpdir(), 'bw-f1370-'));
    const n = parseCount(['--count', '4']);
    const run = deps({ photos: 0 }, []);
    run.d.makePhotos = (numbers) => makePhotos(numbers, dir);
    const sent: string[] = [];
    const send = run.d.runSend;
    run.d.runSend = (args, env) => {
      sent.push(...args.slice(4));
      return send(args, env);
    };
    expect(await seedHaroldPhotos({ server: SERVER, ...PW, count: n }, run.d)).toMatchObject({ sent: 4, photos: 4 });
    checkSeeded(sent, n, dir);
  });
});
