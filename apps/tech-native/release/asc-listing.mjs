// SPDX-License-Identifier: AGPL-3.0-or-later
// App Store Connect listing tool (P8-APPSTORE, section 3 D-25, section 11 item 28), beside asc.mjs and on the same key file and stub seam.
//   node release/asc-listing.mjs read                 GET only: everything apply writes, as App Store Connect holds it now (no private value printed)
//   node release/asc-listing.mjs apply [--dry-run]    writes the listing in release/listing/ (listing.json, <locale>/*.txt, screenshots/), reads it
//                                                     all back, and when the read-back matches submits the version for review (manual release)
// apply runs in 3 phases. (1) Preflight, before any write: the local listing (the "demo" refusal, the text limits, each screenshot's pixel size), the
// private values (the reviewer password and the sample seed from the hosted secrets file, the App Review contact from app-review.env, each file
// mode 600), then App Store Connect reads: the version (refused when any version is with Apple, F-1716), build N VALID and APP_STORE_ELIGIBLE (F-1721), an editable app info, the
// age rating questions against the typed table (F-1703), the free price point. (2) Writes, in order: version string, copyright and manual release;
// build; <locale> description, keywords, promotional text, support URL; privacy policy URL; primary category; age rating; content rights; price
// (Free, skipped when already Free); availability (skipped when it matches); App Review details (contact, reviewer account, notes); each screenshot
// set (a screenshot is kept only when it is delivered and its MD5 matches the local file; any other is deleted and sent again, F-1712). (3) The
// read-back of every field, every configured screenshot set included (F-1707); only when it matches, the submission (an open submission is reused).
// Re-run: every write is a PATCH to a value or a skip on a match, so a run that stopped part-way converges on the next; after the submission the
// version is with Apple and a re-run is refused (exit 2) before any write.
// --dry-run sends no write: it runs the preflight and the reads and prints each write it would send. Both modes refuse, with exit 2 and before any
// request, a listing text (the review notes included) that holds "demo" in any case (FR-IOS-4, guideline 2.2).
// Exit 0 ok (apply: submitted); 1 the read-back differs or the submission is not confirmed (nothing submitted when the read-back differs);
// 2 usage, refused, or the API refused; 3 (--dry-run only) the dry run is done but apply would refuse for a missing private value it names.
// The key and the issuer id are read from ~/.appstoreconnect and never printed; the key id is the owner's, from BW_ASC_KEY_ID or the owner's private
// file (owner-env.cjs). No private value (reviewer password, sample password, contact) is ever printed: every text the tool prints is scrubbed of them.
// Test seams: BW_ASC_API (http://127.0.0.1:<port> only) names a stub App Store Connect; BW_ASC_STEP_MS shortens the delivery poll (stub only);
// BW_HOSTED_SECRETS and BW_APP_REVIEW_ENV name the 2 private files (default ~/.brightwater-owner/hosted-secrets.env and app-review.env).
// Time (F-1285): this tool reads no system clock; the token is stamped with App Store Connect's own Date header.
import { createHash, createHmac, createPrivateKey, sign } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ownerEnv from './owner-env.cjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const cmd = args[0];
const dry = args.includes('--dry-run');
const listingDir = (() => {
  const i = args.indexOf('--listing');
  return i >= 0 ? path.resolve(args[i + 1] ?? '') : path.join(here, 'listing');
})();
const secrets = [];
// F-1720: a name is a common word (the copyright line, a URL), so a contact name is hidden only where it is the whole printed value or a whole
// quoted JSON string; the email and the phone are distinctive and are hidden wherever they appear.
const exactOnly = [];
const scrub = (t) => {
  let s = String(t);
  for (const v of secrets) if (v) s = s.split(v).join('<hidden>');
  for (const v of exactOnly) {
    if (!v) continue;
    if (s.trim() === v) s = '<hidden>';
    else s = s.split(`"${v}"`).join('"<hidden>"');
  }
  return s;
};
const say = (m) => console.log(scrub(m));
const die = (code, msg) => {
  console.error(`asc-listing: ${scrub(msg)}`);
  process.exit(code);
};
if (!['read', 'apply'].includes(cmd ?? '')) die(2, 'usage: asc-listing.mjs read | apply [--dry-run] [--listing <dir>]');

// ---- the typed age rating table (App Store Connect API 4.6, AgeRatingDeclarationUpdateRequest; F-1703) -------------------------------------------------
const AGE_BOOL = ['advertising', 'ageAssurance', 'gambling', 'healthOrWellnessTopics', 'lootBox', 'messagingAndChat', 'parentalControls', 'socialMedia', 'socialMediaAgeRestricted', 'unrestrictedWebAccess', 'userGeneratedContent'];
const AGE_LEVEL = ['alcoholTobaccoOrDrugUseOrReferences', 'contests', 'gamblingSimulated', 'gunsOrOtherWeapons', 'horrorOrFearThemes', 'matureOrSuggestiveThemes', 'medicalOrTreatmentInformation', 'profanityOrCrudeHumor', 'sexualContentGraphicAndNudity', 'sexualContentOrNudity', 'violenceCartoonOrFantasy', 'violenceRealistic', 'violenceRealisticProlongedGraphicOrSadistic'];
/** Not answered by this tool: overrides, the Kids band, and 2 free-text fields (a Korean rating number, a URL). */
const AGE_SKIP = ['ageRatingOverride', 'ageRatingOverrideV2', 'developerAgeRatingInfoUrl', 'gracRatingClassificationNumber', 'kidsAgeBand', 'koreaAgeRatingOverride'];
const ageTarget = (k) => (AGE_BOOL.includes(k) ? false : AGE_LEVEL.includes(k) ? 'NONE' : undefined);

// ---- the listing, and the "demo" refusal (before any request) ---------------------------------------------------------------------------------------
const cfg = JSON.parse(readFileSync(path.join(listingDir, 'listing.json'), 'utf8'));
const loc = path.join(listingDir, cfg.locale);
const text = (n) => readFileSync(path.join(loc, `${n}.txt`), 'utf8').replace(/\s+$/, '');
const copy = { description: text('description'), keywords: text('keywords'), promotionalText: text('promotional') };
const review = cfg.review;
const tech = review.sampleTechnician?.include === true ? review.sampleTechnician : null;
const notesBase = text(review.notes);
const notesTech = tech ? text(tech.notes) : '';
const TOKEN = '{{SAMPLE_TECHNICIAN_PASSWORD}}';
const checked = { ...copy, reviewNotes: notesBase, reviewNotesSampleTechnician: notesTech, demoAccountName: review.demoAccountName, copyright: cfg.copyright, supportUrl: cfg.supportUrl, privacyPolicyUrl: cfg.privacyPolicyUrl, versionString: cfg.versionString };
for (const [k, v] of Object.entries(checked)) {
  if (/demo/i.test(v)) die(2, `the listing text "${k}" holds "demo"; refused, nothing sent`);
}
if (copy.keywords.length > 100) die(2, `keywords are ${copy.keywords.length} characters; the limit is 100; refused, nothing sent`);
if (copy.promotionalText.length > 170) die(2, 'promotional text is over 170 characters; refused, nothing sent');
if (copy.description.length > 4000) die(2, 'description is over 4000 characters; refused, nothing sent');
if (tech && notesTech.split(TOKEN).length !== 2) die(2, `${tech.notes}.txt must hold ${TOKEN} exactly once; refused, nothing sent`);
if (cfg.price?.free !== true) die(2, 'listing.json price: this tool sets only a free price ("free": true); refused, nothing sent');
const md5 = (b) => createHash('md5').update(b).digest('hex');
/** Each configured screenshot set with its local files, each checked for its PNG pixel size (the IHDR chunk) before any request. */
const shotSets = cfg.screenshots.map((s) => {
  const d = path.join(listingDir, s.dir);
  const names = existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.png')).sort() : [];
  if (names.length < 1 || names.length > 10) die(2, `${s.dir} holds ${names.length} PNG file(s); a set takes 1 to 10; refused, nothing sent`);
  const files = names.map((name) => {
    const bytes = readFileSync(path.join(d, name));
    const png = bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString('latin1', 12, 16) === 'IHDR';
    const w = png ? bytes.readUInt32BE(16) : 0;
    const h = png ? bytes.readUInt32BE(20) : 0;
    if (w !== s.width || h !== s.height) die(2, `${s.dir}/${name} is ${png ? `${w} x ${h}` : 'not a PNG'}; ${s.displayType} takes ${s.width} x ${s.height}; refused, nothing sent`);
    return { name, bytes, md5: md5(bytes) };
  });
  return { ...s, files };
});

// ---- the private values (apply only; read never needs them) ------------------------------------------------------------------------------------------
const ownerDir = path.join(homedir(), '.brightwater-owner');
/** A missing private value refuses apply (exit 2, nothing sent); --dry-run notes it, goes on, and ends with exit 3. */
const missing = [];
const need = (msg) => {
  if (!dry) die(2, `${msg}; nothing sent`);
  missing.push(msg);
  say(`DRY-RUN note: apply would refuse: ${msg}`);
};
/** KEY=VALUE lines of a private file that must exist and be mode 600 (no group or other bits). */
function privateFile(file, what) {
  if (!existsSync(file)) return need(`${what} ${file} is missing`) ?? new Map();
  if ((statSync(file).mode & 0o077) !== 0) return need(`${what} ${file} can be read by others; run chmod 600 on it`) ?? new Map();
  const out = new Map();
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.replace(/\r$/, '');
    const eq = line.indexOf('=');
    if (line.startsWith('#') || eq < 1) continue;
    if (!out.has(line.slice(0, eq).trim())) out.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  return out;
}
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** SD-9 (packages/db/src/passwords.ts): the first 10 characters of Crockford base32 of HMAC-SHA256(seed, email), shown xxxxx-xxxxx. */
function shownSamplePassword(seed, email) {
  let out = '';
  let acc = 0;
  let bits = 0;
  for (const byte of createHmac('sha256', seed).update(email).digest()) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  return `${out.slice(0, 5)}-${out.slice(5, 10)}`;
}
const CONTACT = { contactFirstName: 'BW_REVIEW_CONTACT_FIRST_NAME', contactLastName: 'BW_REVIEW_CONTACT_LAST_NAME', contactEmail: 'BW_REVIEW_CONTACT_EMAIL', contactPhone: 'BW_REVIEW_CONTACT_PHONE' };
let reviewAttrs = null;
if (cmd === 'apply') {
  const hosted = privateFile(process.env.BW_HOSTED_SECRETS || path.join(ownerDir, 'hosted-secrets.env'), 'the hosted secrets file');
  const contactFile = privateFile(process.env.BW_APP_REVIEW_ENV || path.join(ownerDir, 'app-review.env'), 'the App Review contact file');
  const pw = hosted.get('REVIEWER_PASSWORD') ?? '';
  if (!pw) need('the hosted secrets file has no REVIEWER_PASSWORD value');
  secrets.push(pw);
  let notes = notesBase;
  if (tech) {
    const seed = hosted.get('SAMPLE_PASSWORD_SEED') ?? '';
    if (!seed) need('the hosted secrets file has no SAMPLE_PASSWORD_SEED value (the sample technician notes need it)');
    const shown = seed ? shownSamplePassword(seed, tech.email) : '';
    secrets.push(seed, shown, shown.replace('-', ''));
    notes = `${notesBase}\n\n${notesTech.replace(TOKEN, shown)}`;
  }
  if (notes.length > 4000) die(2, 'the review notes are over 4000 characters; refused, nothing sent');
  if (/demo/i.test(notes)) die(2, 'the review notes hold "demo"; refused, nothing sent');
  const contact = {};
  for (const [attr, key] of Object.entries(CONTACT)) {
    contact[attr] = contactFile.get(key) ?? '';
    if (!contact[attr]) need(`the App Review contact file has no value for ${key}`);
    (attr === 'contactFirstName' || attr === 'contactLastName' ? exactOnly : secrets).push(contact[attr]);
  }
  reviewAttrs = { ...contact, demoAccountName: review.demoAccountName, demoAccountPassword: pw, demoAccountRequired: review.demoAccountRequired === true, notes };
}

// ---- the key, the stub seam, the token (asc.mjs's) ---------------------------------------------------------------------------------------------------
const dir = path.join(homedir(), '.appstoreconnect');
let KEY_ID = null;
try {
  KEY_ID = ownerEnv.ownerAppleId('BW_ASC_KEY_ID');
} catch (e) {
  die(2, `${e.message}; nothing signed or sent`);
}
if (KEY_ID === null) die(2, 'BW_ASC_KEY_ID is not set (the environment, or the owner\'s private file); nothing signed or sent');
const BUNDLE_ID = 'com.johnloring.rightontime';
const issuer = readFileSync(path.join(dir, 'issuer_id.txt'), 'utf8').trim();
secrets.push(issuer);
const STUB = process.env.BW_ASC_API ?? '';
if (STUB && !/^http:\/\/(127\.0\.0\.1|localhost):\d{1,5}$/.test(STUB)) die(2, 'BW_ASC_API must be http://127.0.0.1:<port> or http://localhost:<port>; refused, nothing signed or sent');
if (STUB) console.error(`asc-listing: BW_ASC_API is set: the target is the stub at ${STUB}, not App Store Connect`);
const API = STUB || 'https://api.appstoreconnect.apple.com';
const STEP_MS = (STUB && Number(process.env.BW_ASC_STEP_MS)) || 5000;
let appleNow = null;
const noteDate = (r) => {
  const ms = Date.parse(r.headers.get('date') ?? '');
  if (Number.isFinite(ms)) appleNow = Math.floor(ms / 1000);
};
const b64 = (b) => Buffer.from(b).toString('base64url');
async function token() {
  if (appleNow === null) noteDate(await fetch(`${API}/v1/apps`, { method: 'HEAD' }));
  if (appleNow === null) die(2, 'App Store Connect answered with no Date header, so no token can be stamped');
  const head = b64(JSON.stringify({ alg: 'ES256', kid: KEY_ID, typ: 'JWT' }));
  const body = b64(JSON.stringify({ iss: issuer, iat: appleNow, exp: appleNow + 900, aud: 'appstoreconnect-v1' }));
  const key = createPrivateKey(readFileSync(path.join(dir, `AuthKey_${KEY_ID}.p8`)));
  return `${head}.${body}.${b64(sign('sha256', Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' }))}`;
}
async function call(method, p, bodyObj) {
  const r = await fetch(p.startsWith('http') ? p : `${API}${p}`, {
    method,
    headers: { Authorization: `Bearer ${await token()}`, ...(bodyObj ? { 'Content-Type': 'application/json' } : {}) },
    body: bodyObj ? JSON.stringify(bodyObj) : undefined,
  });
  noteDate(r);
  const t = await r.text();
  let json = null;
  try {
    json = t ? JSON.parse(t) : null;
  } catch {
    /* not JSON */
  }
  return { status: r.status, json, text: scrub(t) };
}
async function get(p, soft = false) {
  const r = await call('GET', p);
  if (r.status >= 300) {
    if (soft) return null;
    die(2, `GET ${p.split('?')[0]} answered ${r.status}: ${r.text.slice(0, 300)}`);
  }
  return r.json;
}
/** Every page of a list (links.next is followed only while it stays on the same API host, so the token goes nowhere else). With missingOk a
 *  first page that answers 404 is an empty list: Apple answers 404 for the manual prices of a price schedule no price was ever set on. */
async function getAll(p, missingOk = false) {
  const data = [];
  const included = [];
  for (let next = p; next; ) {
    const r = await call('GET', next);
    if (missingOk && next === p && r.status === 404) return { data, included };
    if (r.status >= 300) die(2, `GET ${next.split('?')[0]} answered ${r.status}: ${r.text.slice(0, 300)}`);
    const j = r.json;
    data.push(...(j?.data ?? []));
    included.push(...(j?.included ?? []));
    const n = j?.links?.next;
    next = typeof n === 'string' && n.startsWith(`${API}/`) ? n : null;
  }
  return { data, included };
}
/** Every write goes here: --dry-run prints it and sends nothing. A body is never printed (the review details hold private values). */
let writes = 0;
const isDry = (id) => String(id).startsWith('dry-');
async function write(method, p, bodyObj, what) {
  writes += 1;
  if (dry) {
    say(`DRY-RUN would ${method} ${p.split('?')[0]}  (${what})`);
    return { status: 0, json: { data: { id: `dry-${writes}`, attributes: {} } } };
  }
  const r = await call(method, p, bodyObj);
  say(`${method} ${p.split('?')[0]} -> ${r.status}  (${what})`);
  if (r.status >= 300) die(2, `${method} ${p.split('?')[0]} answered ${r.status}: ${errorDetail(r)}`);
  return r;
}
/** F-1722: Apple's whole errors array (status, code, title, detail, source pointer or parameter, meta.associatedErrors), scrubbed; a body that is not JSON is shown up to 4000 characters. */
function errorDetail(r) {
  const errs = r.json?.errors;
  if (!Array.isArray(errs) || errs.length === 0) return r.text.slice(0, 4000);
  const one = (e) => ({ status: e?.status, code: e?.code, title: e?.title, detail: e?.detail, source: e?.source, meta: e?.meta });
  return scrub(JSON.stringify(errs.map(one))).slice(0, 8000);
}
const rel = (type, id) => ({ data: { type, id } });
/** Read-back comparison of a text: line endings and trailing white space are App Store Connect's to normalize. */
const sameText = (a, b) => typeof a === 'string' && typeof b === 'string' && a.replace(/\r\n/g, '\n').trim() === b.replace(/\r\n/g, '\n').trim();
/** A screenshot on App Store Connect is the local file when its MD5 matches (or, when no checksum is returned, its size). */
const sameShot = (x, f) => x.attributes?.fileName === f.name && (x.attributes?.sourceFileChecksum ? x.attributes.sourceFileChecksum === f.md5 : x.attributes?.fileSize === f.bytes.length);

// ---- reads -------------------------------------------------------------------------------------------------------------------------------------------
const appId = (await get(`/v1/apps?filter[bundleId]=${BUNDLE_ID}`)).data[0]?.id ?? die(2, `no app record with bundle id ${BUNDLE_ID}`);
/** A version these states name can be edited; any version in WITH_APPLE has been submitted, and the tool then writes nothing (F-1716). */
const EDITABLE = ['PREPARE_FOR_SUBMISSION', 'READY_FOR_REVIEW', 'DEVELOPER_REJECTED', 'REJECTED', 'METADATA_REJECTED', 'INVALID_BINARY'];
const WITH_APPLE = ['WAITING_FOR_REVIEW', 'IN_REVIEW', 'PENDING_DEVELOPER_RELEASE', 'PENDING_APPLE_RELEASE', 'PROCESSING_FOR_DISTRIBUTION', 'PROCESSING_FOR_APP_STORE', 'WAITING_FOR_EXPORT_COMPLIANCE'];
const SUBMISSION_BUSY = ['WAITING_FOR_REVIEW', 'IN_REVIEW', 'CANCELING', 'COMPLETING'];
const SUBMISSION_OPEN = ['READY_FOR_REVIEW', 'UNRESOLVED_ISSUES'];
const INFO_EDITABLE = ['PREPARE_FOR_SUBMISSION', 'READY_FOR_REVIEW', 'DEVELOPER_REJECTED', 'REJECTED'];
const vState = (v) => v.attributes.appVersionState ?? v.attributes.appStoreState;
const iState = (i) => i.attributes?.state ?? i.attributes?.appStoreState;
const versions = async () => (await get(`/v1/apps/${appId}/appStoreVersions?filter[platform]=IOS&limit=20`)).data;
const submissions = async () => (await getAll(`/v1/apps/${appId}/reviewSubmissions?filter[platform]=IOS&limit=50`)).data;
async function infoOf(editableOnly) {
  const infos = (await get(`/v1/apps/${appId}/appInfos`)).data;
  return infos.find((i) => INFO_EDITABLE.includes(iState(i))) ?? (editableOnly ? null : infos[0]);
}
async function priceNow() {
  const s = await get(`/v1/apps/${appId}/appPriceSchedule`, true);
  if (!s?.data) return null;
  const base = await get(`/v1/appPriceSchedules/${s.data.id}/baseTerritory`, true);
  const manual = await getAll(`/v1/appPriceSchedules/${s.data.id}/manualPrices?include=appPricePoint&limit=200`, true);
  const points = new Map(manual.included.filter((x) => x.type === 'appPricePoints').map((x) => [x.id, x]));
  const prices = manual.data.map((m) => points.get(m.relationships?.appPricePoint?.data?.id ?? '')?.attributes?.customerPrice);
  return { base: base?.data?.id ?? null, free: prices.length > 0 && prices.every((c) => c !== undefined && Number(c) === 0), count: prices.length };
}
async function availabilityNow() {
  const a = await get(`/v1/apps/${appId}/appAvailabilityV2`, true);
  if (!a?.data) return null;
  const t = await getAll(`/v2/appAvailabilities/${a.data.id}/territoryAvailabilities?include=territory&limit=200`);
  const rows = t.data.map((r) => ({ id: r.id, territory: r.relationships?.territory?.data?.id, available: r.attributes?.available === true }));
  return { inNew: a.data.attributes?.availableInNewTerritories, rows, on: rows.filter((r) => r.available).map((r) => r.territory).sort() };
}
const want = new Set(cfg.availability.territories);
const availabilityMatches = (a) => !!a && a.inNew === cfg.availability.availableInNewTerritories && a.on.join(',') === [...want].sort().join(',');

if (cmd === 'read') {
  await report(false);
  process.exit(0);
}

// ---- apply, phase 1: the preflight (reads only; every refusal here is before any write) ----------------------------------------------------------------
say(`asc-listing: ${dry ? 'DRY RUN (no write is sent)' : 'apply'}: version ${cfg.versionString}, build ${cfg.buildVersion}, ${shotSets.map((s) => `${s.files.length} screenshot(s) of ${s.displayType}`).join(', ')}`);
const allVersions = await versions();
const withApple = allVersions.find((v) => WITH_APPLE.includes(vState(v)));
if (withApple) die(2, `version ${withApple.attributes.versionString} is ${vState(withApple)}: it has been submitted, and the tool writes nothing while Apple has it (F-1716); nothing written`);
const busy = (await submissions()).find((s) => SUBMISSION_BUSY.includes(s.attributes?.state));
if (busy) die(2, `a review submission is ${busy.attributes.state}: the tool writes nothing while Apple has it (F-1716); nothing written`);
let vs = allVersions.find((v) => v.attributes.versionString === cfg.versionString);
if (vs && !EDITABLE.includes(vState(vs))) die(2, `version ${cfg.versionString} is ${vState(vs)}, which cannot be edited; nothing written`);
vs ??= allVersions.find((v) => EDITABLE.includes(vState(v)));
const bl = (await get(`/v1/builds?filter[app]=${appId}&filter[version]=${cfg.buildVersion}&filter[processingState]=VALID&limit=10`)).data;
if (bl.length !== 1) die(2, `expected exactly 1 VALID build numbered ${cfg.buildVersion}, found ${bl.length}; nothing written`);
// F-1721: Apple refuses to attach a build that was uploaded for internal TestFlight testing only (409 on the attach); refuse before the first write.
const audience = bl[0].attributes?.buildAudienceType;
if (audience !== 'APP_STORE_ELIGIBLE') die(2, `build ${cfg.buildVersion} has buildAudienceType ${audience ?? 'none'}, not APP_STORE_ELIGIBLE: it cannot be attached to an App Store version; upload it with export-upload.sh store; nothing written`);
const info = (await infoOf(true)) ?? die(2, 'no app info can be edited (each is with Apple or live); nothing written');
const age = (await get(`/v1/appInfos/${info.id}/ageRatingDeclaration`)).data;
const ageAttrs = {};
for (const k of Object.keys(age.attributes ?? {})) {
  if (AGE_SKIP.includes(k)) continue;
  const t = ageTarget(k);
  if (t === undefined) die(2, `the age rating question "${k}" is not in the tool's typed table (API 4.6); add its type first; nothing written`);
  ageAttrs[k] = t;
}
const price = await priceNow();
const priceMatches = !!price && price.base === cfg.price.baseTerritory && price.free;
let freePoint = null;
if (!priceMatches) {
  const pts = (await getAll(`/v1/apps/${appId}/appPricePoints?filter[territory]=${cfg.price.baseTerritory}&limit=200`)).data.filter((p) => Number(p.attributes?.customerPrice) === 0);
  if (pts.length !== 1) die(2, `expected 1 free price point in ${cfg.price.baseTerritory}, found ${pts.length}; nothing written`);
  freePoint = pts[0].id;
}
const avail = await availabilityNow();
if (avail && !avail.rows.length) die(2, 'the availability lists no territory; nothing written');
if (avail && [...want].some((t) => !avail.rows.some((r) => r.territory === t))) die(2, `the availability has no row for ${[...want].join(', ')}; nothing written`);
const territories = avail ? [] : (await getAll('/v1/territories?limit=200')).data.map((t) => t.id);
if (!avail && [...want].some((t) => !territories.includes(t))) die(2, `App Store Connect lists no territory ${[...want].join(', ')}; nothing written`);
say('preflight: ok (nothing written yet)');

// ---- apply, phase 2: the writes ------------------------------------------------------------------------------------------------------------------------
// 1. the version
const vAttrs = { versionString: cfg.versionString, copyright: cfg.copyright, releaseType: cfg.releaseType };
if (!vs) {
  vs = (await write('POST', '/v1/appStoreVersions', { data: { type: 'appStoreVersions', attributes: { platform: 'IOS', ...vAttrs }, relationships: { app: rel('apps', appId) } } }, 'a new iOS version')).json.data;
} else {
  await write('PATCH', `/v1/appStoreVersions/${vs.id}`, { data: { type: 'appStoreVersions', id: vs.id, attributes: vAttrs } }, 'version string, copyright, manual release');
}
// 2. the build
await write('PATCH', `/v1/appStoreVersions/${vs.id}/relationships/build`, { data: { type: 'builds', id: bl[0].id } }, `attach build ${cfg.buildVersion}`);
// 3. the version localization
const vlocs = isDry(vs.id) ? [] : (await get(`/v1/appStoreVersions/${vs.id}/appStoreVersionLocalizations`)).data;
let vloc = vlocs.find((l) => l.attributes.locale === cfg.locale);
const vlocAttrs = { description: copy.description, keywords: copy.keywords, promotionalText: copy.promotionalText, supportUrl: cfg.supportUrl };
const vlocWhat = `${cfg.locale} description, keywords, promotional text, support URL`;
if (!vloc) {
  vloc = (await write('POST', '/v1/appStoreVersionLocalizations', { data: { type: 'appStoreVersionLocalizations', attributes: { locale: cfg.locale, ...vlocAttrs }, relationships: { appStoreVersion: rel('appStoreVersions', vs.id) } } }, vlocWhat)).json.data;
} else {
  await write('PATCH', `/v1/appStoreVersionLocalizations/${vloc.id}`, { data: { type: 'appStoreVersionLocalizations', id: vloc.id, attributes: vlocAttrs } }, vlocWhat);
}
// 4. the app info: privacy policy URL, primary category, age rating (the typed table)
const iloc = (await get(`/v1/appInfos/${info.id}/appInfoLocalizations`)).data.find((l) => l.attributes.locale === cfg.locale);
if (!iloc) {
  await write('POST', '/v1/appInfoLocalizations', { data: { type: 'appInfoLocalizations', attributes: { locale: cfg.locale, name: 'Right On Time', privacyPolicyUrl: cfg.privacyPolicyUrl }, relationships: { appInfo: rel('appInfos', info.id) } } }, 'privacy policy URL (new localization)');
} else {
  await write('PATCH', `/v1/appInfoLocalizations/${iloc.id}`, { data: { type: 'appInfoLocalizations', id: iloc.id, attributes: { privacyPolicyUrl: cfg.privacyPolicyUrl } } }, 'privacy policy URL');
}
await write('PATCH', `/v1/appInfos/${info.id}`, { data: { type: 'appInfos', id: info.id, relationships: { primaryCategory: rel('appCategories', cfg.primaryCategory) } } }, `primary category ${cfg.primaryCategory}`);
await write('PATCH', `/v1/ageRatingDeclarations/${age.id}`, { data: { type: 'ageRatingDeclarations', id: age.id, attributes: ageAttrs } }, `age rating: ${Object.keys(ageAttrs).length} answers, each None or No`);
// 5. content rights
await write('PATCH', `/v1/apps/${appId}`, { data: { type: 'apps', id: appId, attributes: { contentRightsDeclaration: cfg.contentRightsDeclaration } } }, `content rights ${cfg.contentRightsDeclaration}`);
// 6. the price: Free in the base territory (a schedule is replaced whole; skipped when it is already Free there)
if (priceMatches) say(`price: already Free in ${cfg.price.baseTerritory}, skipped`);
else {
  const local = `\${price-free}`;
  await write('POST', '/v1/appPriceSchedules', { data: { type: 'appPriceSchedules', relationships: { app: rel('apps', appId), baseTerritory: rel('territories', cfg.price.baseTerritory), manualPrices: { data: [{ type: 'appPrices', id: local }] } } }, included: [{ type: 'appPrices', id: local, relationships: { appPricePoint: rel('appPricePoints', freePoint) } }] }, `price Free, base territory ${cfg.price.baseTerritory}`);
}
// 7. the availability: only the listed territories, none added later
if (availabilityMatches(avail)) say(`availability: already ${avail.on.join(', ')} only, skipped`);
else if (!avail) {
  const inc = territories.map((t) => ({ type: 'territoryAvailabilities', id: `\${ta-${t}}`, attributes: { available: want.has(t) }, relationships: { territory: rel('territories', t) } }));
  await write('POST', '/v2/appAvailabilities', { data: { type: 'appAvailabilities', attributes: { availableInNewTerritories: cfg.availability.availableInNewTerritories }, relationships: { app: rel('apps', appId), territoryAvailabilities: { data: inc.map((x) => ({ type: x.type, id: x.id })) } } }, included: inc }, `availability ${[...want].join(', ')} only, of ${territories.length} territories; new territories ${cfg.availability.availableInNewTerritories ? 'added' : 'not added'}`);
} else {
  for (const r of avail.rows.filter((x) => x.available !== want.has(x.territory))) {
    await write('PATCH', `/v1/territoryAvailabilities/${r.id}`, { data: { type: 'territoryAvailabilities', id: r.id, attributes: { available: want.has(r.territory) } } }, `${r.territory} ${want.has(r.territory) ? 'available' : 'not available'}`);
  }
  if (avail.inNew !== cfg.availability.availableInNewTerritories) say('availability: "make available in new territories" differs and the API cannot change it; the read-back reports it');
}
// 8. the App Review details: contact (private file), reviewer account and password (hosted secrets file), notes (listing/<locale>/); never printed
const rdWhat = 'App Review details: contact, sign-in required, reviewer account and password, notes (values not printed)';
const rd = isDry(vs.id) ? null : await get(`/v1/appStoreVersions/${vs.id}/appStoreReviewDetail`, true);
if (rd?.data) await write('PATCH', `/v1/appStoreReviewDetails/${rd.data.id}`, { data: { type: 'appStoreReviewDetails', id: rd.data.id, attributes: reviewAttrs } }, rdWhat);
else await write('POST', '/v1/appStoreReviewDetails', { data: { type: 'appStoreReviewDetails', attributes: reviewAttrs, relationships: { appStoreVersion: rel('appStoreVersions', vs.id) } } }, rdWhat);
// 9. the screenshot sets: keep a delivered screenshot whose name and MD5 match; delete any other and send the file again (F-1712); then the order
const setsNow = isDry(vloc.id) ? [] : (await get(`/v1/appStoreVersionLocalizations/${vloc.id}/appScreenshotSets`)).data;
for (const s of shotSets) {
  let set = setsNow.find((x) => x.attributes.screenshotDisplayType === s.displayType);
  set ??= (await write('POST', '/v1/appScreenshotSets', { data: { type: 'appScreenshotSets', attributes: { screenshotDisplayType: s.displayType }, relationships: { appStoreVersionLocalization: rel('appStoreVersionLocalizations', vloc.id) } } }, `screenshot set ${s.displayType}`)).json.data;
  const have = isDry(set.id) ? [] : (await get(`/v1/appScreenshotSets/${set.id}/appScreenshots`)).data;
  const kept = new Map();
  for (const h of have) {
    const f = s.files.find((x) => x.name === h.attributes?.fileName);
    const state = h.attributes?.assetDeliveryState?.state ?? 'no state';
    if (f && !kept.has(f.name) && state === 'COMPLETE' && sameShot(h, f)) kept.set(f.name, h.id);
    else await write('DELETE', `/v1/appScreenshots/${h.id}`, null, `remove ${h.attributes?.fileName} from ${s.displayType} (${!f ? 'not in the listing' : state !== 'COMPLETE' ? state : 'its MD5 differs or a duplicate'})`);
  }
  for (const f of s.files) {
    if (kept.has(f.name)) {
      say(`screenshot ${s.displayType} ${f.name}: delivered and its MD5 matches, kept`);
      continue;
    }
    const res = (await write('POST', '/v1/appScreenshots', { data: { type: 'appScreenshots', attributes: { fileName: f.name, fileSize: f.bytes.length }, relationships: { appScreenshotSet: rel('appScreenshotSets', set.id) } } }, `reserve ${s.displayType} ${f.name}`)).json.data;
    for (const op of res.attributes?.uploadOperations ?? []) {
      const headers = Object.fromEntries((op.requestHeaders ?? []).map((h) => [h.name, h.value]));
      const up = await fetch(op.url, { method: op.method, headers, body: f.bytes.subarray(op.offset, op.offset + op.length) });
      say(`${op.method} <upload part of ${f.name}> -> ${up.status}`);
      if (!up.ok) die(2, `the upload of ${f.name} answered ${up.status}`);
    }
    await write('PATCH', `/v1/appScreenshots/${res.id}`, { data: { type: 'appScreenshots', id: res.id, attributes: { uploaded: true, sourceFileChecksum: f.md5 } } }, `commit ${s.displayType} ${f.name}`);
    kept.set(f.name, res.id);
  }
  const order = s.files.map((f) => kept.get(f.name));
  const haveOrder = have.map((h) => h.id).filter((id) => order.includes(id));
  if (order.join(',') !== haveOrder.join(',')) await write('PATCH', `/v1/appScreenshotSets/${set.id}/relationships/appScreenshots`, { data: order.map((id) => ({ type: 'appScreenshots', id })) }, `${s.displayType} order ${s.files.map((f) => f.name).join(', ')}`);
}

// ---- apply, phase 3: the read-back, then the submission ------------------------------------------------------------------------------------------------
if (dry) {
  say(`DRY-RUN would read every field back, then ${cfg.submit ? 'submit the version for review (a submission, its item, submitted = true), manual release' : 'stop (listing.json submit is false)'}`);
  say(`asc-listing: DRY RUN done: ${writes} write(s) described, 0 sent${missing.length ? `; apply would refuse until ${missing.length} private value(s) are set (the notes above)` : ''}`);
  process.exit(missing.length ? 3 : 0);
}
if (!(await report(true))) {
  say('asc-listing: NOT SUBMITTED: the read-back differs; fix the MISMATCH lines and run apply again');
  process.exit(1);
}
if (!cfg.submit) {
  say('asc-listing: listing.json submit is false: the listing is written and read back; nothing submitted');
  process.exit(0);
}
let sub = (await submissions()).find((s) => SUBMISSION_OPEN.includes(s.attributes?.state));
sub ??= (await write('POST', '/v1/reviewSubmissions', { data: { type: 'reviewSubmissions', attributes: { platform: 'IOS' }, relationships: { app: rel('apps', appId) } } }, 'a review submission')).json.data;
const items = (await getAll(`/v1/reviewSubmissions/${sub.id}/items?include=appStoreVersion&limit=50`)).data;
if (!items.some((i) => i.relationships?.appStoreVersion?.data?.id === vs.id)) {
  await write('POST', '/v1/reviewSubmissionItems', { data: { type: 'reviewSubmissionItems', relationships: { reviewSubmission: rel('reviewSubmissions', sub.id), appStoreVersion: rel('appStoreVersions', vs.id) } } }, `version ${cfg.versionString} in the submission`);
}
await write('PATCH', `/v1/reviewSubmissions/${sub.id}`, { data: { type: 'reviewSubmissions', id: sub.id, attributes: { submitted: true } } }, 'submit for review');
const subState = (await get(`/v1/reviewSubmissions/${sub.id}`)).data.attributes?.state;
const v3 = (await versions()).find((v) => v.id === vs.id);
say(`submission: ${subState}; version ${cfg.versionString}: ${v3 ? vState(v3) : 'not found'}, release ${v3?.attributes.releaseType ?? 'unknown'}`);
if (!['WAITING_FOR_REVIEW', 'IN_REVIEW'].includes(subState) || v3?.attributes.releaseType !== cfg.releaseType) {
  say('asc-listing: SUBMISSION NOT CONFIRMED: check the version page in App Store Connect');
  process.exit(1);
}
say(`asc-listing: SUBMITTED version ${cfg.versionString} build ${cfg.buildVersion} for review, release ${cfg.releaseType}`);
process.exit(0);

// ---- the read-back / report -----------------------------------------------------------------------------------------------------------------------
async function report(check) {
  let ok = true;
  const bad = (m) => {
    if (!check) return;
    ok = false;
    say(`MISMATCH ${m}`);
  };
  const all = await versions();
  const vs2 = all.find((v) => v.attributes.versionString === cfg.versionString) ?? all.find((v) => EDITABLE.includes(vState(v))) ?? all[0];
  say(`version: ${vs2 ? `${vs2.attributes.versionString} state ${vState(vs2)} release ${vs2.attributes.releaseType} copyright ${vs2.attributes.copyright}` : 'none'}`);
  if (!vs2 || vs2.attributes.versionString !== cfg.versionString) bad('version string');
  if (vs2 && vs2.attributes.releaseType !== cfg.releaseType) bad('release type');
  if (vs2 && vs2.attributes.copyright !== cfg.copyright) bad('copyright');
  if (vs2) {
    const b = await get(`/v1/appStoreVersions/${vs2.id}/build`, true);
    say(`build attached: ${b?.data ? b.data.attributes.version : 'none'}`);
    if (b?.data?.attributes.version !== cfg.buildVersion) bad('attached build');
    const l = (await get(`/v1/appStoreVersions/${vs2.id}/appStoreVersionLocalizations`)).data.find((x) => x.attributes.locale === cfg.locale);
    say(`${cfg.locale}: description ${l?.attributes.description?.length ?? 0} chars, keywords ${l?.attributes.keywords ?? 'none'}, promo ${l?.attributes.promotionalText?.length ?? 0} chars, support ${l?.attributes.supportUrl ?? 'none'}`);
    if (!l) bad('version localization missing');
    for (const k of ['description', 'keywords', 'promotionalText']) if (l && !sameText(l.attributes[k], copy[k])) bad(k);
    if (l && l.attributes.supportUrl !== cfg.supportUrl) bad('supportUrl');
    const sets = l ? (await get(`/v1/appStoreVersionLocalizations/${l.id}/appScreenshotSets`)).data : [];
    for (const s of shotSets) {
      const set = sets.find((x) => x.attributes.screenshotDisplayType === s.displayType);
      if (!set) {
        say(`screenshot set ${s.displayType}: missing`);
        bad(`screenshot set ${s.displayType} missing`);
        continue;
      }
      for (let tries = 0; ; tries += 1) {
        const now = (await get(`/v1/appScreenshotSets/${set.id}/appScreenshots`)).data;
        const pending = now.filter((x) => !['COMPLETE', 'FAILED'].includes(x.attributes?.assetDeliveryState?.state));
        if (!pending.length || tries >= 24 || !check) {
          const done = now.filter((x) => x.attributes?.assetDeliveryState?.state === 'COMPLETE');
          say(`screenshot set ${s.displayType}: ${done.length} of ${now.length} delivered (${s.files.length} in the listing)`);
          for (const x of now.filter((y) => y.attributes?.assetDeliveryState?.state === 'FAILED')) say(`  ${x.attributes.fileName} FAILED: ${(x.attributes.assetDeliveryState.errors ?? []).map((e) => e.code).join(', ')}`);
          const same = now.length === s.files.length && now.every((x, i) => sameShot(x, s.files[i]));
          if (done.length !== now.length) bad(`screenshots of ${s.displayType} not all delivered`);
          if (!same) bad(`screenshots of ${s.displayType} differ from the listing's files (name, order or MD5)`);
          break;
        }
        await new Promise((r) => setTimeout(r, STEP_MS));
      }
    }
    const rd2 = await get(`/v1/appStoreVersions/${vs2.id}/appStoreReviewDetail`, true);
    const ra = rd2?.data?.attributes;
    const contactSet = !!ra && Object.keys(CONTACT).every((k) => !!ra[k]);
    say(`App Review details: ${ra ? `contact ${contactSet ? 'set' : 'not set'}, sign-in required ${ra.demoAccountRequired ? 'yes' : 'no'}, account ${ra.demoAccountName ?? 'none'}, password ${ra.demoAccountPassword ? 'set' : 'not shown'}, notes ${ra.notes?.length ?? 0} chars${tech ? `, sample technician ${ra.notes?.includes(tech.employeeNumber) ? 'included' : 'not included'}` : ''}` : 'none'} (values not printed)`);
    if (check) {
      if (!ra) bad('App Review details missing');
      for (const [k, v] of Object.entries(reviewAttrs ?? {})) {
        if (ra && k === 'demoAccountPassword' && ra[k] === undefined) continue; // App Store Connect may not return the password
        const digits = (x) => String(x ?? '').replace(/\D/g, '');
        const same = k === 'notes' ? sameText(ra?.[k], v) : k === 'contactPhone' ? digits(ra?.[k]) === digits(v) : ra?.[k] === v;
        if (ra && !same) bad(`App Review ${k}`);
      }
    }
  }
  const info2 = await infoOf(false);
  const cat = await get(`/v1/appInfos/${info2.id}/primaryCategory`, true);
  const il = (await get(`/v1/appInfos/${info2.id}/appInfoLocalizations`)).data.find((x) => x.attributes.locale === cfg.locale);
  say(`primary category: ${cat?.data?.id ?? 'none'}; privacy policy URL: ${il?.attributes.privacyPolicyUrl ?? 'none'}`);
  if (cat?.data?.id !== cfg.primaryCategory) bad('primary category');
  if (il?.attributes.privacyPolicyUrl !== cfg.privacyPolicyUrl) bad('privacy policy URL');
  const age2 = (await get(`/v1/appInfos/${info2.id}/ageRatingDeclaration`)).data;
  const ageOff = Object.entries(age2.attributes ?? {}).filter(([k, v]) => !AGE_SKIP.includes(k) && v !== ageTarget(k));
  say(`age rating: ${ageOff.length ? `not None or No: ${ageOff.map(([k, v]) => `${k}=${v}`).join(', ')}` : 'every answer None or No'}`);
  if (ageOff.length) bad('age rating');
  const app = (await get(`/v1/apps/${appId}`)).data;
  say(`content rights: ${app.attributes.contentRightsDeclaration ?? 'unset'}`);
  if (app.attributes.contentRightsDeclaration !== cfg.contentRightsDeclaration) bad('content rights');
  const p = await priceNow();
  say(`price: ${p ? `base territory ${p.base ?? 'none'}, ${p.free ? 'Free' : `not Free (${p.count} manual price(s))`}` : 'not set'}`);
  if (!p || p.base !== cfg.price.baseTerritory || !p.free) bad('price');
  const a = await availabilityNow();
  say(`availability: ${a ? `${a.on.length} territor${a.on.length === 1 ? 'y' : 'ies'}: ${a.on.slice(0, 12).join(', ') || 'none'}; new territories ${a.inNew ? 'added' : 'not added'}` : 'not set'}`);
  if (!availabilityMatches(a)) bad('availability');
  const subs = await submissions();
  say(`review submissions: ${subs.length ? subs.map((s) => s.attributes?.state).join(', ') : 'none'}`);
  if (check) say(ok ? 'asc-listing: READBACK OK' : 'asc-listing: READBACK DIFFERS');
  return ok;
}
