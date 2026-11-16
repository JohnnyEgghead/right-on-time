// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-IOS-4 FR-IOS-5 (the listing tool: the "demo" refusal, --dry-run, the review notes, the App Review details and the submission; P8-APPSTORE)
// release/asc-listing.mjs runs as the release runs it (node, its own process) against a stub App Store Connect on 127.0.0.1: BW_ASC_API points it
// there, a temporary HOME holds a key made for this run and 2 private files made for it (fake values), and the listing it reads is a temporary copy
// of the real one with 2 tiny PNG headers per screenshot set. The stub keeps the API 4.6 shapes the tool depends on: the age rating declaration's
// 30 questions with their types (a wrongly typed answer is refused, F-1703), screenshot delivery by MD5, price points, availability, App Review
// details and review submissions. Nothing reaches Apple.
import { spawn } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { samplePassword, showSamplePassword } from '../../packages/db/src/passwords.ts';

const script = path.resolve(import.meta.dirname, '../../apps/tech-native/release/asc-listing.mjs');
const realListing = path.resolve(import.meta.dirname, '../../apps/tech-native/release/listing');
const LISTED = JSON.parse(readFileSync(path.join(realListing, 'listing.json'), 'utf8')) as { versionString: string; buildVersion: string };
const ISSUER = 'i'.repeat(36);
// Fake private values made for this test only; the tool must never print any of them.
const REVIEWER_PW = 'Fake-Reviewer-Pass-77';
const SEED = 'fake-sample-seed-for-the-test-only';
const CONTACT = { first: 'Testfirst', last: 'Testlast', email: 'contact.test@example.com', phone: '+1 555 010 0199' };
const MARIA = showSamplePassword(samplePassword(SEED, 'maria.santos@brightwater.example'));

const AGE_BOOL = ['advertising', 'ageAssurance', 'gambling', 'healthOrWellnessTopics', 'lootBox', 'messagingAndChat', 'parentalControls', 'socialMedia', 'socialMediaAgeRestricted', 'unrestrictedWebAccess', 'userGeneratedContent'];
const AGE_LEVEL = ['alcoholTobaccoOrDrugUseOrReferences', 'contests', 'gamblingSimulated', 'gunsOrOtherWeapons', 'horrorOrFearThemes', 'matureOrSuggestiveThemes', 'medicalOrTreatmentInformation', 'profanityOrCrudeHumor', 'sexualContentGraphicAndNudity', 'sexualContentOrNudity', 'violenceCartoonOrFantasy', 'violenceRealistic', 'violenceRealisticProlongedGraphicOrSadistic'];
const AGE_TEXT = ['developerAgeRatingInfoUrl', 'gracRatingClassificationNumber'];
const AGE_OTHER = ['ageRatingOverride', 'ageRatingOverrideV2', 'kidsAgeBand', 'koreaAgeRatingOverride'];
const LEVELS = ['NONE', 'INFREQUENT_OR_MILD', 'FREQUENT_OR_INTENSE', 'INFREQUENT', 'FREQUENT'];

let home = '';
let listing = '';
let server: Server | null = null;
/** A PNG signature and IHDR chunk of the given size: the tool reads only these bytes. */
function pngHeader(w: number, h: number, tag: string): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  b.writeUInt8(8, 24);
  b.writeUInt8(2, 25);
  return Buffer.concat([b, Buffer.from(tag)]);
}
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'bw-lst-'));
  const keys = path.join(home, '.appstoreconnect');
  mkdirSync(keys);
  writeFileSync(path.join(keys, 'issuer_id.txt'), `${ISSUER}\n`);
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  writeFileSync(path.join(keys, 'AuthKey_TESTKEY000.p8'), privateKey.export({ type: 'pkcs8', format: 'pem' }));
  listing = path.join(home, 'listing');
  cpSync(realListing, listing, { recursive: true, filter: (src) => !src.endsWith('.png') });
  for (const [dir, w, h] of [['iphone-6.9', 1320, 2868], ['iphone-6.3', 1206, 2622]] as const) {
    rmSync(path.join(listing, 'screenshots', dir), { recursive: true, force: true });
    mkdirSync(path.join(listing, 'screenshots', dir), { recursive: true });
    for (const n of ['1-today.png', '2-job.png']) writeFileSync(path.join(listing, 'screenshots', dir, n), pngHeader(w, h, `${dir}/${n}`));
  }
  const owner = path.join(home, '.brightwater-owner');
  mkdirSync(owner);
  writeFileSync(path.join(owner, 'hosted-secrets.env'), `ACCESS_CODE=unused-in-this-test\nREVIEWER_PASSWORD=${REVIEWER_PW}\nSAMPLE_PASSWORD_SEED=${SEED}\n`, { mode: 0o600 });
  writeFileSync(path.join(owner, 'app-review.env'), `# App Review contact\nBW_REVIEW_CONTACT_FIRST_NAME=${CONTACT.first}\nBW_REVIEW_CONTACT_LAST_NAME=${CONTACT.last}\nBW_REVIEW_CONTACT_EMAIL=${CONTACT.email}\nBW_REVIEW_CONTACT_PHONE=${CONTACT.phone}\n`, { mode: 0o600 });
});
afterEach(async () => {
  await new Promise<void>((res) => (server ? server.close(() => res()) : res()));
  server = null;
  rmSync(home, { recursive: true, force: true });
});

type Body = { data?: { id?: string; attributes?: Record<string, unknown>; relationships?: Record<string, { data: { id: string } | { id: string }[] }> } | { id: string }[]; included?: { id: string; attributes?: Record<string, unknown>; relationships?: Record<string, { data: { id: string } }> }[] };
type Shot = { id: string; fileName: string; fileSize: number; sourceFileChecksum: string | null; state: string; bytes: Buffer };
type Opts = { versionState?: string; submissions?: { id: string; state: string }[]; extraAgeKey?: string; audience?: string; failType?: string; itemError?: boolean; preShots?: (setId: string) => Shot[] };
async function stubAsc(opts: Opts = {}) {
  const requests: { method: string; path: string; body: string }[] = [];
  const version: Record<string, unknown> = { versionString: '1.0', appVersionState: opts.versionState ?? 'PREPARE_FOR_SUBMISSION', releaseType: 'AFTER_APPROVAL' };
  const vloc: Record<string, unknown> = {};
  const iloc: Record<string, unknown> = {};
  const app: Record<string, unknown> = {};
  const age: Record<string, unknown> = Object.fromEntries([...AGE_BOOL, ...AGE_LEVEL, ...AGE_TEXT, ...AGE_OTHER].map((k) => [k, null]));
  if (opts.extraAgeKey) age[opts.extraAgeKey] = null;
  let schedule: { base: string; point: string } | null = null;
  let avail: { inNew: boolean; rows: { id: string; territory: string; available: boolean }[] } | null = null;
  let reviewDetail: Record<string, unknown> | null = null;
  const sets: { id: string; type: string; shots: Shot[] }[] = [];
  const submissions: { id: string; state: string; items: string[] }[] = (opts.submissions ?? []).map((s) => ({ ...s, items: [] }));
  let nextId = 0;
  const id = (p: string) => `${p}-${(nextId += 1)}`;
  server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://stub');
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const body = raw.toString();
      const json = (status: number, data: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      const refuse = (detail: string) => json(409, { errors: [{ status: '409', code: 'ENTITY_ERROR.ATTRIBUTE.TYPE', detail }] });
      if (req.method === 'HEAD') return void res.writeHead(200).end();
      requests.push({ method: req.method ?? '', path: u.pathname, body: req.method === 'PUT' ? `<${raw.length} bytes>` : body });
      const b = (body && req.method !== 'PUT' ? JSON.parse(body) : {}) as Body;
      const d = (Array.isArray(b.data) ? {} : (b.data ?? {})) as Exclude<Body['data'], unknown[] | undefined>;
      const relId = (k: string) => (d?.relationships?.[k]?.data as { id: string } | undefined)?.id;
      const m = req.method;
      const p = u.pathname;
      const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
      const vst = () => ({ id: 'ver-1', attributes: version });
      if (m === 'GET' && p === '/v1/apps') return json(200, { data: [{ id: 'app-1', type: 'apps' }] });
      if (m === 'GET' && p === '/v1/apps/app-1') return json(200, { data: { id: 'app-1', attributes: app } });
      if (m === 'PATCH' && p === '/v1/apps/app-1') return json(200, { data: Object.assign(app, d?.attributes) && { id: 'app-1' } });
      if (m === 'GET' && p === '/v1/apps/app-1/appStoreVersions') return json(200, { data: [vst()] });
      if (m === 'PATCH' && p === '/v1/appStoreVersions/ver-1') return json(200, { data: Object.assign(version, d?.attributes) && { id: 'ver-1' } });
      if (m === 'GET' && p === '/v1/builds') return json(200, { data: [{ id: 'build-8', attributes: { version: u.searchParams.get('filter[version]') ?? LISTED.buildVersion, processingState: 'VALID', buildAudienceType: opts.audience ?? 'APP_STORE_ELIGIBLE' } }] });
      if (m === 'PATCH' && p === '/v1/appStoreVersions/ver-1/relationships/build') {
        version['build'] = d?.id;
        return void res.writeHead(204).end();
      }
      if (m === 'GET' && p === '/v1/appStoreVersions/ver-1/build') return json(200, { data: version['build'] ? { id: 'build-8', attributes: { version: LISTED.buildVersion } } : null });
      if (m === 'GET' && p === '/v1/appStoreVersions/ver-1/appStoreVersionLocalizations') return json(200, { data: vloc['locale'] ? [{ id: 'vl-1', attributes: vloc }] : [] });
      if (m === 'POST' && p === '/v1/appStoreVersionLocalizations') return json(201, { data: Object.assign(vloc, d?.attributes) && { id: 'vl-1', attributes: vloc } });
      if (m === 'PATCH' && p === '/v1/appStoreVersionLocalizations/vl-1') return json(200, { data: Object.assign(vloc, d?.attributes) && { id: 'vl-1' } });
      if (m === 'GET' && p === '/v1/apps/app-1/appInfos') return json(200, { data: [{ id: 'info-live', attributes: { state: 'READY_FOR_DISTRIBUTION' } }, { id: 'info-1', attributes: { state: 'PREPARE_FOR_SUBMISSION' } }] });
      if (m === 'GET' && p === '/v1/appInfos/info-1/appInfoLocalizations') return json(200, { data: iloc['locale'] ? [{ id: 'il-1', attributes: iloc }] : [] });
      if (m === 'POST' && p === '/v1/appInfoLocalizations') return json(201, { data: Object.assign(iloc, d?.attributes) && { id: 'il-1' } });
      if (m === 'PATCH' && p === '/v1/appInfos/info-1') {
        iloc['category'] = relId('primaryCategory');
        return json(200, { data: { id: 'info-1' } });
      }
      if (m === 'GET' && p === '/v1/appInfos/info-1/primaryCategory') return json(200, { data: iloc['category'] ? { id: iloc['category'] } : null });
      if (m === 'GET' && p === '/v1/appInfos/info-1/ageRatingDeclaration') return json(200, { data: { id: 'age-1', attributes: age } });
      if (m === 'PATCH' && p === '/v1/ageRatingDeclarations/age-1') {
        // API 4.6 types: a boolean question takes a boolean, a level question a level, and the free-text ones are not answered with a level.
        for (const [k, v] of Object.entries(d?.attributes ?? {})) {
          if (AGE_BOOL.includes(k) && typeof v !== 'boolean') return refuse(`${k} takes a boolean`);
          if (AGE_LEVEL.includes(k) && !LEVELS.includes(String(v))) return refuse(`${k} takes a level`);
          if ([...AGE_TEXT, ...AGE_OTHER].includes(k) && LEVELS.includes(String(v))) return refuse(`${k} is not a level question`);
          if (!(k in age)) return refuse(`${k} is not a question`);
        }
        return json(200, { data: Object.assign(age, d?.attributes) && { id: 'age-1' } });
      }
      // price: 2 pages of USA price points (the free one on page 2), a schedule made whole by 1 POST
      if (m === 'GET' && p === '/v1/apps/app-1/appPricePoints') {
        return u.searchParams.get('page') === '2'
          ? json(200, { data: [{ id: 'pp-free', attributes: { customerPrice: '0.0' } }] })
          : json(200, { data: [{ id: 'pp-099', attributes: { customerPrice: '0.99' } }], links: { next: `${base}/v1/apps/app-1/appPricePoints?page=2` } });
      }
      // as App Store Connect answers (seen live, Nov 15): an app with no price still has a schedule, and its base territory and manual
      // prices answer 404 until a price is set
      if (m === 'GET' && p === '/v1/apps/app-1/appPriceSchedule') return json(200, { data: { id: 'ps-1' } });
      if (m === 'GET' && p.startsWith('/v1/appPriceSchedules/ps-1/') && !schedule) return json(404, { errors: [{ status: '404', code: 'NOT_FOUND' }] });
      if (m === 'GET' && p === '/v1/appPriceSchedules/ps-1/baseTerritory') return json(200, { data: { id: schedule!.base } });
      if (m === 'GET' && p === '/v1/appPriceSchedules/ps-1/manualPrices') return json(200, { data: [{ id: 'price-1', relationships: { appPricePoint: { data: { id: schedule!.point } } } }], included: [{ type: 'appPricePoints', id: schedule!.point, attributes: { customerPrice: schedule!.point === 'pp-free' ? '0.0' : '0.99' } }] });
      if (m === 'POST' && p === '/v1/appPriceSchedules') {
        const local = (d?.relationships?.['manualPrices']?.data as { id: string }[])[0]!.id;
        const inc = b.included?.find((x) => x.id === local);
        if (!local.startsWith('${') || !inc) return refuse('manualPrices must name an included price by a local id');
        schedule = { base: relId('baseTerritory')!, point: inc.relationships!['appPricePoint']!.data.id };
        return json(201, { data: { id: 'ps-1' } });
      }
      // availability
      if (m === 'GET' && p === '/v1/territories') return json(200, { data: ['USA', 'CAN', 'MEX'].map((t) => ({ id: t, type: 'territories' })) });
      if (m === 'GET' && p === '/v1/apps/app-1/appAvailabilityV2') return avail ? json(200, { data: { id: 'av-1', attributes: { availableInNewTerritories: avail.inNew } } }) : json(404, { errors: [{ status: '404' }] });
      if (m === 'GET' && p === '/v2/appAvailabilities/av-1/territoryAvailabilities') return json(200, { data: avail!.rows.map((r) => ({ id: r.id, attributes: { available: r.available }, relationships: { territory: { data: { id: r.territory } } } })) });
      if (m === 'POST' && p === '/v2/appAvailabilities') {
        if (typeof d?.attributes?.['availableInNewTerritories'] !== 'boolean') return refuse('availableInNewTerritories is required');
        avail = { inNew: d.attributes['availableInNewTerritories'] as boolean, rows: (b.included ?? []).map((x) => ({ id: id('ta'), territory: x.relationships!['territory']!.data.id, available: x.attributes?.['available'] === true })) };
        return json(201, { data: { id: 'av-1' } });
      }
      if (m === 'PATCH' && p.startsWith('/v1/territoryAvailabilities/')) {
        const r = avail!.rows.find((x) => x.id === p.split('/').pop());
        r!.available = d?.attributes?.['available'] === true;
        return json(200, { data: { id: r!.id } });
      }
      // App Review details (the stub, like a cautious API, does not return the password)
      if (m === 'GET' && p === '/v1/appStoreVersions/ver-1/appStoreReviewDetail') {
        if (!reviewDetail) return json(404, { errors: [{ status: '404' }] });
        const shown = Object.fromEntries(Object.entries(reviewDetail).filter(([k]) => k !== 'demoAccountPassword'));
        return json(200, { data: { id: 'rd-1', attributes: shown } });
      }
      if (m === 'POST' && p === '/v1/appStoreReviewDetails') {
        reviewDetail = { ...d?.attributes };
        return json(201, { data: { id: 'rd-1' } });
      }
      if (m === 'PATCH' && p === '/v1/appStoreReviewDetails/rd-1') return json(200, { data: Object.assign(reviewDetail!, d?.attributes) && { id: 'rd-1' } });
      // screenshots: a set per display type; a screenshot is delivered when the bytes sent match the committed MD5
      if (m === 'GET' && p === '/v1/appStoreVersionLocalizations/vl-1/appScreenshotSets') return json(200, { data: sets.map((s) => ({ id: s.id, attributes: { screenshotDisplayType: s.type } })) });
      if (m === 'POST' && p === '/v1/appScreenshotSets') {
        const s = { id: id('set'), type: String(d?.attributes?.['screenshotDisplayType']), shots: [] as Shot[] };
        s.shots = opts.preShots?.(s.id) ?? [];
        sets.push(s);
        return json(201, { data: { id: s.id } });
      }
      const setOf = (sid: string) => sets.find((s) => s.id === sid);
      const shotOf = (hid: string) => sets.flatMap((s) => s.shots).find((x) => x.id === hid);
      const view = (x: Shot) => ({ id: x.id, attributes: { fileName: x.fileName, fileSize: x.fileSize, sourceFileChecksum: x.sourceFileChecksum, assetDeliveryState: { state: x.state, errors: x.state === 'FAILED' ? [{ code: 'IMAGE_INCORRECT_DIMENSIONS' }] : [] } } });
      if (m === 'GET' && /^\/v1\/appScreenshotSets\/[^/]+\/appScreenshots$/.test(p)) return json(200, { data: setOf(p.split('/')[3]!)!.shots.map(view) });
      if (m === 'PATCH' && /^\/v1\/appScreenshotSets\/[^/]+\/relationships\/appScreenshots$/.test(p)) {
        const s = setOf(p.split('/')[3]!)!;
        s.shots = (b.data as { id: string }[]).map((x) => s.shots.find((y) => y.id === x.id)!);
        return void res.writeHead(204).end();
      }
      if (m === 'POST' && p === '/v1/appScreenshots') {
        const s = setOf(relId('appScreenshotSet')!)!;
        const x: Shot = { id: id('sh'), fileName: String(d?.attributes?.['fileName']), fileSize: Number(d?.attributes?.['fileSize']), sourceFileChecksum: null, state: 'AWAITING_UPLOAD', bytes: Buffer.alloc(0) };
        s.shots.push(x);
        return json(201, { data: { id: x.id, attributes: { uploadOperations: [{ method: 'PUT', url: `${base}/blob/${x.id}`, offset: 0, length: x.fileSize, requestHeaders: [{ name: 'Content-Type', value: 'image/png' }] }] } } });
      }
      if (m === 'PUT' && p.startsWith('/blob/')) {
        shotOf(p.split('/')[2]!)!.bytes = raw;
        return void res.writeHead(200).end();
      }
      if (m === 'PATCH' && p.startsWith('/v1/appScreenshots/')) {
        const x = shotOf(p.split('/')[3]!)!;
        const set = sets.find((s) => s.shots.includes(x))!;
        x.sourceFileChecksum = String(d?.attributes?.['sourceFileChecksum']);
        const good = createHash('md5').update(x.bytes).digest('hex') === x.sourceFileChecksum && set.type !== opts.failType;
        x.state = good ? 'COMPLETE' : 'FAILED';
        return json(200, { data: { id: x.id } });
      }
      if (m === 'DELETE' && p.startsWith('/v1/appScreenshots/')) {
        for (const s of sets) s.shots = s.shots.filter((x) => x.id !== p.split('/')[3]);
        return void res.writeHead(204).end();
      }
      // review submissions
      if (m === 'GET' && p === '/v1/apps/app-1/reviewSubmissions') return json(200, { data: submissions.map((s) => ({ id: s.id, attributes: { state: s.state } })) });
      if (m === 'POST' && p === '/v1/reviewSubmissions') {
        const s = { id: id('sub'), state: 'READY_FOR_REVIEW', items: [] as string[] };
        submissions.push(s);
        return json(201, { data: { id: s.id } });
      }
      const subOf = (sid: string) => submissions.find((s) => s.id === sid);
      if (m === 'GET' && /^\/v1\/reviewSubmissions\/[^/]+\/items$/.test(p)) return json(200, { data: subOf(p.split('/')[3]!)!.items.map((v, i) => ({ id: `item-${i}`, relationships: { appStoreVersion: { data: { id: v } } } })) });
      if (m === 'POST' && p === '/v1/reviewSubmissionItems') {
        if (opts.itemError) {
          return json(409, {
            errors: [
              {
                status: '409',
                code: 'STATE_ERROR.ENTITY_STATE_INVALID',
                title: 'The version cannot be submitted',
                detail: `Item refused for ${REVIEWER_PW}`,
                source: { pointer: '/data/relationships/appStoreVersion' },
                meta: { associatedErrors: { '/v1/appStoreVersions/ver-1': [{ code: 'ENTITY_ERROR.ATTRIBUTE.REQUIRED', title: 'Missing', detail: 'A required field is empty: ' + 'x'.repeat(500) }] } },
              },
            ],
          });
        }
        subOf(relId('reviewSubmission')!)!.items.push(relId('appStoreVersion')!);
        return json(201, { data: { id: id('item') } });
      }
      if (m === 'GET' && p.startsWith('/v1/reviewSubmissions/')) {
        const s = subOf(p.split('/')[3]!)!;
        return json(200, { data: { id: s.id, attributes: { state: s.state } } });
      }
      if (m === 'PATCH' && p.startsWith('/v1/reviewSubmissions/')) {
        const s = subOf(p.split('/')[3]!)!;
        if (d?.attributes?.['submitted'] === true && s.items.length) {
          s.state = 'WAITING_FOR_REVIEW';
          if (s.items.includes('ver-1')) version['appVersionState'] = 'WAITING_FOR_REVIEW';
        }
        return json(200, { data: { id: s.id } });
      }
      return json(404, { errors: [{ status: '404', detail: `${m} ${p}` }] });
    });
  });
  await new Promise<void>((res) => server!.listen(0, '127.0.0.1', () => res()));
  const api = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  const writes = () => requests.filter((q) => !['GET', 'HEAD'].includes(q.method));
  return { requests, writes, api, sets, reviewDetail: () => reviewDetail, age, submissions };
}

function tool(api: string, args: string[], extra: Record<string, string> = {}): Promise<{ code: number | null; out: string; err: string }> {
  const env = { PATH: process.env['PATH'] ?? '', HOME: home, BW_ASC_API: api, BW_ASC_STEP_MS: '5', BW_ASC_KEY_ID: 'TESTKEY000', BW_OWNER_ENV: path.join(home, 'o.env'), BW_OWNER_ENV_LOCAL: path.join(home, 'o2.env'), ...extra };
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [script, ...args, '--listing', listing], { env });
    let out = '';
    let err = '';
    p.stdout.on('data', (c: Buffer) => (out += c.toString()));
    p.stderr.on('data', (c: Buffer) => (err += c.toString()));
    p.on('close', (code) => resolve({ code, out, err }));
  });
}
const PRIVATE = [REVIEWER_PW, SEED, MARIA, MARIA.replace('-', ''), CONTACT.first, CONTACT.last, CONTACT.email, CONTACT.phone, ISSUER];
function expectNoPrivateValue(r: { out: string; err: string }) {
  for (const v of PRIVATE) {
    expect(r.out).not.toContain(v);
    expect(r.err).not.toContain(v);
  }
}

describe('release/asc-listing.mjs (P8-APPSTORE)', () => {
  // why: FR-IOS-4 a listing text, the review notes included, holding "demo" in any case is refused with exit 2 before any request: the stub sees none
  it.each(['description', 'keywords', 'promotional', 'review-notes', 'review-notes-sample-technician'])('refuses a %s text that holds "demo" in any case, sending nothing', async (name) => {
    const { requests, api } = await stubAsc();
    const f = path.join(listing, 'en-US', `${name}.txt`);
    writeFileSync(f, `${readFileSync(f, 'utf8').trim()} DeMo`);
    for (const args of [['apply'], ['apply', '--dry-run']]) {
      const r = await tool(api, args);
      expect(r.code).toBe(2);
      expect(r.err).toContain('holds "demo"; refused, nothing sent');
    }
    expect(requests).toEqual([]);
  });

  // why: FR-IOS-4 --dry-run prints each write and sends none: the stub sees GET requests only, and every write group is described
  it('--dry-run reads, prints every write it would send, and sends none', async () => {
    const stub = await stubAsc();
    const r = await tool(stub.api, ['apply', '--dry-run']);
    expect(r.code).toBe(0);
    expect(stub.writes()).toEqual([]);
    for (const line of ['PATCH /v1/appStoreVersions/ver-1  (version', 'PATCH /v1/appStoreVersions/ver-1/relationships/build', 'PATCH /v1/ageRatingDeclarations/age-1', 'POST /v1/appPriceSchedules', 'POST /v2/appAvailabilities', 'POST /v1/appStoreReviewDetails', 'reserve APP_IPHONE_67 1-today.png', 'reserve APP_IPHONE_61 2-job.png', 'submit the version for review']) {
      expect(r.out).toContain(line);
    }
    expect(r.out).toMatch(/0 sent/);
    expectNoPrivateValue(r);
  });

  // why: FR-IOS-4 the review notes App Store Connect receives explain the sample data and the server clock, hold no "demo", and match on read-back
  it('the submitted review notes explain the sample data and the server clock', async () => {
    const stub = await stubAsc();
    const r = await tool(stub.api, ['apply']);
    expect(r.code).toBe(0);
    const notes = String(stub.reviewDetail()!['notes']);
    expect(notes).toMatch(/Sample data: everything on the site is made-up sample data/);
    expect(notes).toMatch(/Server clock: the app shows the sample company's time, which comes from the server, not from the phone/);
    expect(notes).not.toMatch(/demo/i);
    expect(r.out).not.toContain('MISMATCH');
  });

  // why: FR-IOS-5 the App Review details carry the reviewer account with sign-in required, its password from the hosted secrets file, the contact
  // from app-review.env and (flag on) the sample technician's sign-in derived by SD-9; no private value is printed
  it('App Review details: reviewer account, password, contact and the sample technician, none printed', async () => {
    const stub = await stubAsc();
    const r = await tool(stub.api, ['apply']);
    expect(r.code).toBe(0);
    const rd = stub.reviewDetail()!;
    expect(rd).toMatchObject({ demoAccountName: 'reviewer@brightwater.example', demoAccountPassword: REVIEWER_PW, demoAccountRequired: true, contactFirstName: CONTACT.first, contactLastName: CONTACT.last, contactEmail: CONTACT.email, contactPhone: CONTACT.phone });
    expect(String(rd['notes'])).toContain(`employee number, 40712, then enter ${MARIA} as the password`);
    expectNoPrivateValue(r);
  });

  // why: FR-IOS-5 with the sample technician flag off, the notes hold the reviewer explanation only and no sample password
  it('the sample technician flag off leaves the notes without her sign-in', async () => {
    const f = path.join(listing, 'listing.json');
    const cfg = JSON.parse(readFileSync(f, 'utf8')) as { review: { sampleTechnician: { include: boolean } } };
    cfg.review.sampleTechnician.include = false;
    writeFileSync(f, JSON.stringify(cfg));
    const stub = await stubAsc();
    const r = await tool(stub.api, ['apply']);
    expect(r.code).toBe(0);
    expect(String(stub.reviewDetail()!['notes'])).not.toContain('40712');
    expect(String(stub.reviewDetail()!['notes'])).not.toContain(MARIA);
  });

  // why: FR-IOS-5 a clean apply writes every field (price Free in USA, availability USA only, both screenshot sets), reads it back, then submits with
  // manual release; the age rating is answered by the typed table, so the stub's API 4.6 type check accepts it (F-1703)
  it('apply writes the listing, the read-back matches, and the version is submitted', async () => {
    const stub = await stubAsc();
    const r = await tool(stub.api, ['apply']);
    expect(r.out).toContain('READBACK OK');
    expect(r.out).toContain(`SUBMITTED version ${LISTED.versionString} build ${LISTED.buildVersion} for review, release MANUAL`);
    expect(r.code).toBe(0);
    const w = stub.writes().map((q) => `${q.method} ${q.path}`);
    for (const x of ['PATCH /v1/appStoreVersions/ver-1', 'PATCH /v1/ageRatingDeclarations/age-1', 'POST /v1/appPriceSchedules', 'POST /v2/appAvailabilities', 'POST /v1/appStoreReviewDetails', 'POST /v1/reviewSubmissions', 'POST /v1/reviewSubmissionItems']) expect(w).toContain(x);
    expect(w.indexOf('PATCH /v1/reviewSubmissions/sub-' + stub.submissions[0]!.id.split('-')[1])).toBe(w.length - 1);
    const v = stub.requests.find((q) => q.path === '/v1/appStoreVersions/ver-1' && q.method === 'PATCH')!;
    expect(JSON.parse(v.body).data.attributes).toEqual({ versionString: LISTED.versionString, copyright: '2026 John Loring', releaseType: 'MANUAL' });
    const ageSent = JSON.parse(stub.requests.find((q) => q.path === '/v1/ageRatingDeclarations/age-1')!.body).data.attributes as Record<string, unknown>;
    expect(ageSent).toEqual(Object.fromEntries([...AGE_BOOL.map((k) => [k, false]), ...AGE_LEVEL.map((k) => [k, 'NONE'])]));
    expect(stub.sets.map((s) => [s.type, s.shots.map((x) => `${x.fileName} ${x.state}`)])).toEqual([
      ['APP_IPHONE_67', ['1-today.png COMPLETE', '2-job.png COMPLETE']],
      ['APP_IPHONE_61', ['1-today.png COMPLETE', '2-job.png COMPLETE']],
    ]);
    const avail = JSON.parse(stub.requests.find((q) => q.path === '/v2/appAvailabilities')!.body) as { data: { attributes: unknown }; included: { attributes: { available: boolean }; relationships: { territory: { data: { id: string } } } }[] };
    expect(avail.data.attributes).toEqual({ availableInNewTerritories: false });
    expect(avail.included.filter((x) => x.attributes.available).map((x) => x.relationships.territory.data.id)).toEqual(['USA']);
    expect(r.out).toContain('price: base territory USA, Free');
    expectNoPrivateValue(r);
  });

  // why: F-1716 once the version is with Apple, apply (and a re-run after a submission) writes nothing and exits 2
  it('refuses to write while a version or a submission is with Apple, and a re-run after submitting writes nothing', async () => {
    for (const opts of [{ versionState: 'WAITING_FOR_REVIEW' }, { submissions: [{ id: 'sub-x', state: 'IN_REVIEW' }] }] as Opts[]) {
      const stub = await stubAsc(opts);
      const r = await tool(stub.api, ['apply']);
      expect(r.code).toBe(2);
      expect(r.err).toContain('F-1716');
      expect(stub.writes()).toEqual([]);
      await new Promise<void>((res) => server!.close(() => res()));
      server = null;
    }
    const stub = await stubAsc();
    expect((await tool(stub.api, ['apply'])).code).toBe(0);
    const before = stub.writes().length;
    const again = await tool(stub.api, ['apply']);
    expect(again.code).toBe(2);
    expect(again.err).toContain('is WAITING_FOR_REVIEW: it has been submitted');
    expect(stub.writes().length).toBe(before);
  });

  // why: F-1712 a re-run keeps a delivered screenshot whose MD5 matches and deletes and resends a half-uploaded one or one whose MD5 differs
  it('a re-run repairs half-uploaded and stale screenshots and keeps the delivered ones', async () => {
    const good = readFileSync(path.join(listing, 'screenshots', 'iphone-6.9', '1-today.png'));
    const md5 = createHash('md5').update(good).digest('hex');
    const pre = (sid: string): Shot[] => [
      { id: `${sid}-a`, fileName: '1-today.png', fileSize: good.length, sourceFileChecksum: md5, state: 'COMPLETE', bytes: good },
      { id: `${sid}-b`, fileName: '2-job.png', fileSize: 33, sourceFileChecksum: null, state: 'AWAITING_UPLOAD', bytes: Buffer.alloc(0) },
      { id: `${sid}-c`, fileName: 'old.png', fileSize: 10, sourceFileChecksum: 'ffff', state: 'COMPLETE', bytes: Buffer.alloc(0) },
    ];
    const stub = await stubAsc({ preShots: pre });
    const r = await tool(stub.api, ['apply']);
    expect(r.code).toBe(0);
    const big = stub.sets.find((s) => s.type === 'APP_IPHONE_67')!;
    expect(big.shots.map((x) => `${x.id.endsWith('-a') ? 'kept' : 'new'} ${x.fileName} ${x.state}`)).toEqual(['kept 1-today.png COMPLETE', 'new 2-job.png COMPLETE']);
    const deleted = stub.writes().filter((q) => q.method === 'DELETE').map((q) => q.path);
    expect(deleted.filter((p) => p.includes(big.id))).toEqual([`/v1/appScreenshots/${big.id}-b`, `/v1/appScreenshots/${big.id}-c`]);
    // the medium set was given the large 1-today.png: its MD5 is not the medium file's, so it is stale and resent too
    const mid = stub.sets.find((s) => s.type === 'APP_IPHONE_61')!;
    expect(deleted.filter((p) => p.includes(mid.id))).toEqual([`/v1/appScreenshots/${mid.id}-a`, `/v1/appScreenshots/${mid.id}-b`, `/v1/appScreenshots/${mid.id}-c`]);
    expect(mid.shots.map((x) => `${x.fileName} ${x.state}`)).toEqual(['1-today.png COMPLETE', '2-job.png COMPLETE']);
    expect(r.out).toContain('screenshot APP_IPHONE_67 1-today.png: delivered and its MD5 matches, kept');
  });

  // why: F-1707 every configured display type is read back: a set Apple does not deliver (here the medium display) makes the read-back differ, exit 1,
  // and nothing is submitted
  it('a medium-display set that is not delivered fails the read-back and stops the submission', async () => {
    const stub = await stubAsc({ failType: 'APP_IPHONE_61' });
    const r = await tool(stub.api, ['apply']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('MISMATCH screenshots of APP_IPHONE_61 not all delivered');
    expect(r.out).toContain('IMAGE_INCORRECT_DIMENSIONS');
    expect(r.out).toContain('NOT SUBMITTED');
    expect(stub.writes().some((q) => q.path.includes('reviewSubmission'))).toBe(false);
  });

  // why: F-1722 the whole errors array of a refused write is printed (code, title, detail, source pointer, associatedErrors), longer than 400 characters, with private values hidden
  it('prints the whole error answer of a refused write, scrubbed', async () => {
    const stub = await stubAsc({ itemError: true });
    const r = await tool(stub.api, ['apply']);
    expect(r.code).toBe(2);
    for (const x of ['answered 409', 'STATE_ERROR.ENTITY_STATE_INVALID', 'The version cannot be submitted', '/data/relationships/appStoreVersion', 'associatedErrors', 'ENTITY_ERROR.ATTRIBUTE.REQUIRED', 'x'.repeat(500)]) expect(r.err).toContain(x);
    expect(r.err).not.toContain(REVIEWER_PW);
    expect(r.err).toContain('<hidden>');
  });

  // why: F-1724 Apple's Unlisted page asks the review notes to say the app is for Unlisted App Distribution; the file ends with that exact line
  it('the review notes file ends with the Unlisted App Distribution line', () => {
    const notes = readFileSync(path.join(realListing, 'en-US', 'review-notes.txt'), 'utf8').trimEnd();
    expect(notes.split('\n').at(-1)).toBe('This app is intended for Unlisted App Distribution. We have filed an Unlisted App Distribution request for it.');
  });

  // why: F-1711 the tool checks the copyright, support URL, privacy policy URL, version string and sign-in name for "demo" too; each is planted here
  it.each(['copyright', 'supportUrl', 'privacyPolicyUrl', 'versionString'])('refuses a listing.json %s that holds "demo", sending nothing', async (key) => {
    const { requests, api } = await stubAsc();
    const f = path.join(listing, 'listing.json');
    const cfg = JSON.parse(readFileSync(f, 'utf8')) as Record<string, string>;
    cfg[key] = `${cfg[key]} DeMo`;
    writeFileSync(f, JSON.stringify(cfg));
    const r = await tool(api, ['apply']);
    expect(r.code).toBe(2);
    expect(r.err).toContain(`the listing text "${key}" holds "demo"; refused, nothing sent`);
    expect(requests).toEqual([]);
  });

  it('refuses a sign-in name that holds "demo", sending nothing', async () => {
    const { requests, api } = await stubAsc();
    const f = path.join(listing, 'listing.json');
    const cfg = JSON.parse(readFileSync(f, 'utf8')) as { review: Record<string, string> };
    cfg.review['demoAccountName'] = 'demo-reviewer@brightwater.example';
    writeFileSync(f, JSON.stringify(cfg));
    const r = await tool(api, ['apply']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('"demoAccountName" holds "demo"; refused, nothing sent');
    expect(requests).toEqual([]);
  });

  // why: F-1721 Apple answers 409 when an INTERNAL_ONLY build (uploaded for TestFlight internal testing only) is attached to a version: the tool
  // refuses before its first write and names the audience it found; an APP_STORE_ELIGIBLE build goes on (the clean apply test above)
  it('refuses a build that is not APP_STORE_ELIGIBLE before any write, naming its audience', async () => {
    const stub = await stubAsc({ audience: 'INTERNAL_ONLY' });
    const r = await tool(stub.api, ['apply']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('buildAudienceType INTERNAL_ONLY, not APP_STORE_ELIGIBLE');
    expect(r.err).toContain('nothing written');
    expect(stub.writes()).toEqual([]);
  });

  // why: F-1720 the contact scrub hides a contact value only where it is the printed value: a name inside the copyright line or a URL stays readable
  it('keeps the copyright line and URLs readable while the contact stays hidden', async () => {
    writeFileSync(path.join(home, '.brightwater-owner', 'app-review.env'), `BW_REVIEW_CONTACT_FIRST_NAME=John\nBW_REVIEW_CONTACT_LAST_NAME=github\nBW_REVIEW_CONTACT_EMAIL=${CONTACT.email}\nBW_REVIEW_CONTACT_PHONE=${CONTACT.phone}\n`, { mode: 0o600 });
    const stub = await stubAsc();
    const r = await tool(stub.api, ['apply']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('copyright 2026 John Loring');
    expect(r.out).toContain('https://github.com/');
    expect(r.out + r.err).not.toContain(CONTACT.email);
    expect(r.out + r.err).not.toContain(CONTACT.phone);
  });

  // why: F-1703 an age rating question outside the typed table is refused before any write, never answered with a guessed type
  it('refuses an unknown age rating question before any write', async () => {
    const stub = await stubAsc({ extraAgeKey: 'someNewQuestion' });
    const r = await tool(stub.api, ['apply']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('"someNewQuestion" is not in the tool\'s typed table');
    expect(stub.writes()).toEqual([]);
  });

  // why: F-1702 the private files must be mode 600 and hold every value: apply refuses before any request; --dry-run names what is missing, exit 3
  it('private files: a readable or incomplete file refuses apply; --dry-run notes it and exits 3', async () => {
    const stub = await stubAsc();
    const contact = path.join(home, '.brightwater-owner', 'app-review.env');
    chmodSync(contact, 0o644);
    const r1 = await tool(stub.api, ['apply']);
    expect(r1.code).toBe(2);
    expect(r1.err).toContain('can be read by others');
    chmodSync(contact, 0o600);
    writeFileSync(contact, 'BW_REVIEW_CONTACT_FIRST_NAME=\n');
    const r2 = await tool(stub.api, ['apply']);
    expect(r2.code).toBe(2);
    expect(r2.err).toContain('no value for BW_REVIEW_CONTACT_FIRST_NAME');
    expect(stub.requests).toEqual([]);
    const r3 = await tool(stub.api, ['apply', '--dry-run']);
    expect(r3.code).toBe(3);
    expect(r3.out).toContain('apply would refuse until 4 private value(s) are set');
    expect(stub.writes()).toEqual([]);
  });

  // why: F-1707 a screenshot whose pixel size is not its display type's is refused before any request
  it('refuses a screenshot of the wrong pixel size before any request', async () => {
    const stub = await stubAsc();
    writeFileSync(path.join(listing, 'screenshots', 'iphone-6.3', '3-map.png'), pngHeader(1179, 2556, 'x'));
    const r = await tool(stub.api, ['apply', '--dry-run']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('3-map.png is 1179 x 2556; APP_IPHONE_61 takes 1206 x 2622');
    expect(stub.requests).toEqual([]);
  });

  // why: F-1702 read sends GET only and reports price, availability, App Review details and submissions without a private value
  it('read sends GET only and prints no private value', async () => {
    const stub = await stubAsc();
    await tool(stub.api, ['apply']);
    const n = stub.writes().length;
    const r = await tool(stub.api, ['read']);
    expect(r.code).toBe(0);
    expect(stub.writes().length).toBe(n);
    expect(r.out).toContain('App Review details: contact set, sign-in required yes, account reviewer@brightwater.example');
    expect(r.out).toContain('availability: 1 territory: USA; new territories not added');
    expect(r.out).toContain('review submissions: WAITING_FOR_REVIEW');
    expectNoPrivateValue(r);
  });

  // why: F-1829 the listing's version string and build must equal the app's (app.json version and ios.buildNumber): the tool attaches the build named in listing.json under the version named there, so a stale pair attaches a pulled build
  it('listing.json version and build equal app.json version and buildNumber', () => {
    const listing = JSON.parse(readFileSync(path.join(realListing, 'listing.json'), 'utf8'));
    const app = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../../apps/tech-native/app.json'), 'utf8')).expo;
    expect(listing.versionString).toBe(app.version);
    expect(listing.buildVersion).toBe(app.ios.buildNumber);
  });
});
