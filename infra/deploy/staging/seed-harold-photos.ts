// SPDX-License-Identifier: AGPL-3.0-or-later
// P6-TESTFLIGHT-4 (F-1350): puts the 3 photos session step 5 checks on Harold Jenkins's Sep 15 job on the staging copy. The world seed
// has no photo, and apps/tech-native/xcuitest/seed-photos.mjs (the photo sender the native suite uses) needs Maria Santos's web session
// token, an office web session token and a wire time, which xcuitest/run.sh mints by a database insert on the local stack only. Here
// they come through the copy's own API: Maria signs in (API-03, employee number 40712) and the office signs in as Keisha Thompson
// (keisha.t@brightwater.example), each with the password file `staging.sh world` wrote (mode 600) into the state folder; the wire time
// is the copy's own real clock (API-10 realNow, read with the office session), never this Mac's. The builder runs it once, after
// `staging.sh world` and add-live-job.ts, before rendering the session page; nothing starts it on its own.
//   BW_STAGING_DIR=<state folder> node infra/deploy/staging/seed-harold-photos.ts
// It talks only to the copy named in the state folder (<state folder>/host, which `staging.sh create` writes). The tokens reach
// seed-photos.mjs in its environment only: never an argument, a printed line or a file. Both sessions are signed out at the end (API-06).
// P6-BUILD5-FIXES (F-1370): each photo is a picture a person can check at a glance, the large label "Photo <k>" on a field color of its
// own (photoSvg, rendered by rsvg-convert, made JPEG by sips), so a tile or a full view that draws it is told apart from a broken one;
// the noise pictures sent before looked broken when drawn right. The count is a flag (default 3), so P6-TESTFLIGHT-5 can seed 1 more
// than the photo row shows in view:
//   BW_STAGING_DIR=<state folder> node infra/deploy/staging/seed-harold-photos.ts [--count <n>]
// A re-run converges on n: it reads the job's photos first (API-101, as Maria) and sends only the ones missing, labeled on from the ones
// there (a job holding 1 gets Photo 2 to Photo n); a job holding more than n is refused (the page names n). It ends by reading, as the
// phone does (API-101 nextJob), which job Harold's Directions goes to.
// Prints 1 line per step and ends with a line that starts "seed-harold-photos:". Exit 0 the job holds n; 1 refused; 2 usage.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isMain } from '../../../ci/is-main.ts';
import { checkServer, HAROLD, type FetchFn } from './add-live-job.ts';

/** The office account of the builder's staging scripts (packages/db/src/seed/reference-data.ts: the Columbus dispatcher). */
export const OFFICE_LOGIN = 'keisha.t@brightwater.example';
/** Maria Santos signs in by her employee number, as the owner does on the page. */
export const MARIA_LOGIN = '40712';
const MARIA = 'Maria Santos';
const BRANCH = 'columbus';
/** The demo day the session runs on (the world seed's Sep 15). */
export const DEMO_DAY = '2026-09-15';
/** Build 4's session step 5 read Photos (3): the count with no --count flag. */
export const PHOTOS = 3;
/** The most --count takes (a typo of 100 would send 100 photos to the copy). */
export const MAX_PHOTOS = 24;

const root = path.resolve(import.meta.dirname, '../../..');
const SEND = path.join(root, 'apps/tech-native/xcuitest/seed-photos.mjs');

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any
export class SeedRefused extends Error {}

export interface Deps {
  fetchFn: FetchFn;
  /** Makes 1 JPEG per photo number (the picture labeled "Photo <k>") and answers their paths, in the same order. */
  makePhotos: (numbers: number[]) => string[];
  /** Runs seed-photos.mjs with these arguments and these variables added to its environment. */
  runSend: (args: string[], env: Record<string, string>) => { status: number | null; stdout: string };
  log: (line: string) => void;
}
export interface Seeded { jobNumber: number; sent: number; photos: number; nextJob: { jobNumber: number; customerName: string } | null }

/** API-10's realNow (any zone) as the wire time seed-photos.mjs reads from BW_REAL_NOW: UTC, whole seconds, +00:00[UTC]. */
export function utcWire(realNow: string): string {
  const t = Date.parse(realNow.replace(/\[.*\]$/, ''));
  if (Number.isNaN(t)) throw new SeedRefused(`the copy's clock answered a time that does not parse: ${realNow}`);
  return `${new Date(t).toISOString().slice(0, 19)}+00:00[UTC]`;
}

async function signIn(server: string, fetchFn: FetchFn, login: string, password: string, who: string): Promise<string> {
  const r = await fetchFn(`${server}/api/v1/sessions`, {
    method: 'POST', headers: { origin: server, 'content-type': 'application/json' },
    body: JSON.stringify({ login, password, client: 'web', keepSignedIn: false }),
  });
  const token = r.headers.getSetCookie().map((c) => c.split(';')[0] ?? '').find((c) => c.startsWith('bw_session='))?.slice('bw_session='.length);
  if (r.status !== 200 || !token) throw new SeedRefused(`${who}'s sign-in answered ${r.status}`);
  return token;
}

/** `--count <n>` (1 to MAX_PHOTOS) or PHOTOS without it; anything else is a usage error. */
export function parseCount(argv: string[]): number {
  if (argv.length === 0) return PHOTOS;
  const n = argv[0] === '--count' && argv.length === 2 && /^\d+$/.test(argv[1] ?? '') ? Number(argv[1]) : NaN;
  if (!(n >= 1 && n <= MAX_PHOTOS)) throw new SeedRefused(`usage: [--count <n>], n from 1 to ${MAX_PHOTOS} (got ${argv.join(' ')})`);
  return n;
}

export async function seedHaroldPhotos(opts: { server: string; mariaPassword: string; officePassword: string; count?: number }, deps: Deps): Promise<Seeded> {
  const server = checkServer(opts.server);
  const count = opts.count ?? PHOTOS;
  const get = async (token: string, p: string): Promise<{ status: number; json: Json }> => {
    const r = await deps.fetchFn(`${server}/api/v1${p}`, { method: 'GET', headers: { cookie: `bw_session=${token}` } });
    const text = await r.text();
    return { status: r.status, json: text ? JSON.parse(text) : null };
  };
  const tokens: string[] = [];
  try {
    const maria = await signIn(server, deps.fetchFn, MARIA_LOGIN, opts.mariaPassword, MARIA);
    tokens.push(maria);
    const office = await signIn(server, deps.fetchFn, OFFICE_LOGIN, opts.officePassword, 'the office');
    tokens.push(office);
    deps.log(`seed-harold-photos: signed in as ${MARIA} (${MARIA_LOGIN}) and as the office (${OFFICE_LOGIN})`);

    const board = await get(office, `/board?branch=${BRANCH}&date=${DEMO_DAY}`);
    const row = (board.json?.data?.technicians as Json[] | undefined)?.find((t) => t.name === MARIA);
    const harold = (row?.jobs as Json[] | undefined)?.find((j) => j.customerName === HAROLD);
    if (board.status !== 200 || !harold) throw new SeedRefused(`the board answered ${board.status} with no ${HAROLD} job on ${MARIA}'s ${DEMO_DAY}`);
    const jobNumber = harold.jobNumber as number;

    const held = async (): Promise<Json> => {
      const r = await get(maria, `/tech/jobs/${jobNumber}`);
      if (r.status !== 200) throw new SeedRefused(`${MARIA}'s read of job ${jobNumber} answered ${r.status}`);
      return r.json.data;
    };
    const before = (await held()).photos.length as number;
    if (before > count) throw new SeedRefused(`job ${jobNumber} already holds ${before} photos, more than the ${count} the page names`);
    const need = count - before;
    if (need === 0) {
      deps.log(`seed-harold-photos: job ${jobNumber} already holds ${count} photos: nothing sent`);
    } else {
      const clock = await get(office, '/clock');
      if (clock.status !== 200) throw new SeedRefused(`the clock read answered ${clock.status}`);
      const realNow = utcWire(clock.json.data.realNow as string);
      const files = deps.makePhotos(Array.from({ length: need }, (_, k) => before + k + 1));
      const r = deps.runSend([SEND, server, server, String(jobNumber), ...files], { BW_SEED_TOKEN: maria, BW_CLOCK_TOKEN: office, BW_REAL_NOW: realNow });
      for (const line of r.stdout.split('\n').filter(Boolean)) deps.log(`seed-harold-photos: photo ${line}`);
      if (r.status !== 0) throw new SeedRefused(`seed-photos.mjs exited ${r.status}: not every photo was applied`);
    }
    const after = await held();
    const photos = after.photos.length as number;
    if (photos !== count) throw new SeedRefused(`job ${jobNumber} holds ${photos} photos after the send, not ${count}`);
    let nextJob: Seeded['nextJob'] = null;
    if (typeof after.job.nextJob === 'number') {
      const n = await get(maria, `/tech/jobs/${after.job.nextJob}`);
      nextJob = { jobNumber: after.job.nextJob, customerName: n.status === 200 ? (n.json.data.customer.name as string) : `(read answered ${n.status})` };
    }
    return { jobNumber, sent: need, photos, nextJob };
  } finally {
    for (const t of tokens) {
      await deps.fetchFn(`${server}/api/v1/sessions/current`, { method: 'DELETE', headers: { cookie: `bw_session=${t}`, origin: server } }).catch(() => undefined);
    }
  }
}

/** The pictures' size: landscape, as a phone photo, and under the 2048 x 2048 small-copy cap (F-1265). */
export const PHOTO_W = 1200;
export const PHOTO_H = 900;

/**
 * Photo k's field color: hues a golden angle apart (no 2 of the first MAX_PHOTOS within 8 degrees), dark enough that the white label
 * reads on every one. Answers #rrggbb.
 */
export function fieldColor(k: number): string {
  const h = ((k - 1) * 137.508) % 360;
  const s = 0.62;
  const l = 0.36;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): string => {
    const m = (n + h / 30) % 12;
    const c = l - a * Math.max(-1, Math.min(m - 3, 9 - m, 1));
    return Math.round(c * 255).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/** Photo k as SVG: the field color and, across most of its width, the white label "Photo <k>". */
export function photoSvg(k: number): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${PHOTO_W}" height="${PHOTO_H}" viewBox="0 0 ${PHOTO_W} ${PHOTO_H}">`,
    `<rect width="${PHOTO_W}" height="${PHOTO_H}" fill="${fieldColor(k)}"/>`,
    `<text x="${PHOTO_W / 2}" y="${PHOTO_H / 2}" text-anchor="middle" dominant-baseline="central" font-family="Helvetica, Arial, sans-serif" font-weight="bold" font-size="260" fill="#ffffff">Photo ${k}</text>`,
    '</svg>',
  ].join('');
}

function run(cmd: string, args: string[], what: string): void {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.status !== 0) throw new SeedRefused(`${what} failed (${cmd} exited ${r.status ?? r.error?.message})`);
}

/**
 * 1 JPEG per photo number: photoSvg rendered by rsvg-convert, then made JPEG by sips (macOS; the builder's Mac runs this), in a new folder
 * under the system's temporary folder unless `dir` is given.
 */
export function makePhotos(numbers: number[], dir = mkdtempSync(path.join(tmpdir(), 'bw-harold-photos-'))): string[] {
  return numbers.map((k) => {
    const svg = path.join(dir, `photo-${k}.svg`);
    const png = path.join(dir, `photo-${k}.png`);
    const jpg = path.join(dir, `photo-${k}.jpg`);
    writeFileSync(svg, photoSvg(k));
    run('rsvg-convert', ['-w', String(PHOTO_W), '-h', String(PHOTO_H), '-o', png, svg], `drawing photo ${k}`);
    run('sips', ['-s', 'format', 'jpeg', png, '--out', jpg], `making photo ${k} a JPEG`);
    return jpg;
  });
}

if (isMain(import.meta.url)) {
  try {
    const dir = process.env['BW_STAGING_DIR'];
    if (!dir) throw new SeedRefused('usage: BW_STAGING_DIR=<state folder> node infra/deploy/staging/seed-harold-photos.ts [--count <n>]');
    const count = parseCount(process.argv.slice(2));
    const read = (f: string): string => {
      try {
        return readFileSync(path.join(dir, f), 'utf8').trim();
      } catch {
        throw new SeedRefused(`no ${f} in the state folder (run staging.sh create and world first)`);
      }
    };
    const s = await seedHaroldPhotos({ server: `https://${read('host')}`, mariaPassword: read('maria-password.txt'), officePassword: read('office-password.txt'), count }, {
      fetchFn: fetch, makePhotos: (numbers) => makePhotos(numbers),
      runSend: (args, env) => {
        const r = spawnSync(process.execPath, args, { encoding: 'utf8', env: { ...process.env, ...env } });
        return { status: r.status, stdout: r.stdout ?? '' };
      },
      log: (l) => process.stdout.write(`${l}\n`),
    });
    const next = s.nextJob ? `the phone's next job after it is ${s.nextJob.jobNumber} (${s.nextJob.customerName})` : 'the phone names no next job (is the demo clock on Sep 15?)';
    process.stdout.write(`seed-harold-photos: done, ${HAROLD}'s job ${s.jobNumber} holds ${s.photos} photos (${s.sent} sent now); ${next}\n`);
  } catch (e) {
    const msg = (e as Error).message;
    process.stderr.write(`seed-harold-photos: ${msg}\n`);
    process.exit(msg.startsWith('usage') ? 2 : 1);
  }
}
