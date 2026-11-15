// SPDX-License-Identifier: AGPL-3.0-or-later
// App Store Connect API calls for the TestFlight upload (P6-TESTFLIGHT). GET requests, plus the one write of add-to-group; the key and the issuer id are read from
// ~/.appstoreconnect and never printed. Usage:
//   node release/asc.mjs builds             the app's builds: version, processing state, internal build state, encryption flag, upload date
//   node release/asc.mjs readback <version> exit 0 only when that build is VALID, not expired, and READY_FOR_BETA_TESTING or IN_BETA_TESTING
//                                           (available to internal testers) and is in at least 1 internal group; prints the groups that hold it
//   node release/asc.mjs add-to-group <version>  the only write: POST /v1/betaGroups/<Owner>/relationships/builds for that build; prints the HTTP status.
//                                           A fresh upload is not listed for some minutes (F-1366) and then processes (F-1390): it reads the builds
//                                           every 60 s, for at most 45 minutes (cap), until that build is listed and processing VALID, then adds it once;
//                                           INVALID or FAILED, or not VALID by the cap, it exits 1 with nothing written
//   node release/asc.mjs wait <version>     readback every 60 s, for at most 45 minutes (cap), until the build is available or failed
// The release order (F-1366): upload, add-to-group, wait, readback. wait needs the group: a build in no internal group is never available.
// Exit 0 ok; 1 the build is not (yet) listed or available to internal testers, or failed; 2 usage or the API refused.
// Test seam (ci/native/asc-add-to-group.test.ts): BW_ASC_API points the tool at a stub App Store Connect, and only with it set do BW_ASC_STEP_MS and
// BW_ASC_CAP_MS shorten the 60 s step and the 45-minute cap; the key and issuer id are read from $HOME/.appstoreconnect, so the stub's are a temporary HOME's.
// Time (F-1285): this tool reads no system clock (SPECIFICATIONS section 4.2: only @bw/time does, and section 11.3 names no release use). The token's
// iat and exp come from App Store Connect's own clock, the Date header of its last answer, which is the clock Apple checks them against; the wait's
// 45-minute cap is a timer, which reads no clock (section 11.3).
import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import ownerEnv from './owner-env.cjs';

const { ownerAppleId } = ownerEnv;

const dir = path.join(homedir(), '.appstoreconnect');
// F-1621: the key id is the owner's, so it is in no exported file: BW_ASC_KEY_ID from the environment or the owner's private file (owner-env.cjs).
let KEY_ID = null;
try {
  KEY_ID = ownerAppleId('BW_ASC_KEY_ID');
} catch (e) {
  console.error(`asc: ${e.message}; nothing signed or sent`);
  process.exit(2);
}
if (KEY_ID === null) {
  console.error("asc: BW_ASC_KEY_ID is not set (the App Store Connect API key id: the environment, or the line BW_ASC_KEY_ID=<key id> in the owner's private file); nothing signed or sent");
  process.exit(2);
}
const BUNDLE_ID = 'com.johnloring.rightontime';
const issuer = readFileSync(path.join(dir, 'issuer_id.txt'), 'utf8').trim();

const STUB = process.env.BW_ASC_API ?? '';
// F-1391: the test hook may name only a stub on this machine; anything else would get a signed token and be reported as Apple's.
if (STUB) {
  if (!/^http:\/\/(127\.0\.0\.1|localhost):\d{1,5}$/.test(STUB)) {
    console.error('asc: BW_ASC_API must be http://127.0.0.1:<port> or http://localhost:<port>; refused, nothing signed or sent');
    process.exit(2);
  }
  console.error(`asc: BW_ASC_API is set: the target is the stub at ${STUB}, not App Store Connect`);
}
const API = STUB || 'https://api.appstoreconnect.apple.com';
/** The polls' step and cap: 60 s and 45 minutes, against Apple always; a stub run may shorten them. */
const STEP_MS = (STUB && Number(process.env.BW_ASC_STEP_MS)) || 60_000;
const CAP_MS = (STUB && Number(process.env.BW_ASC_CAP_MS)) || 45 * 60 * 1000;
/** A timer that sets `capped` after CAP_MS (a timer reads no clock, F-1285); unref'd, so it never keeps the process alive. */
function capTimer() {
  const c = { capped: false };
  setTimeout(() => {
    c.capped = true;
  }, CAP_MS).unref();
  return c;
}
const pause = () => new Promise((res) => setTimeout(res, STEP_MS));
/** App Store Connect's time in epoch seconds, from the Date header of its last answer; null before the first. */
let appleNow = null;
function noteDate(r) {
  const ms = Date.parse(r.headers.get('date') ?? '');
  if (Number.isFinite(ms)) appleNow = Math.floor(ms / 1000);
}
/** The time a token is stamped with: the last answer's Date (at most about 1 minute old: the wait's step), or, before any answer, an unsigned HEAD's. */
async function appleTime() {
  if (appleNow === null) noteDate(await fetch(`${API}/v1/apps`, { method: 'HEAD' }));
  if (appleNow === null) {
    console.error('asc: App Store Connect answered with no Date header, so no token can be stamped');
    process.exit(2);
  }
  return appleNow;
}
const b64 = (b) => Buffer.from(b).toString('base64url');
async function token() {
  const head = b64(JSON.stringify({ alg: 'ES256', kid: KEY_ID, typ: 'JWT' }));
  const now = await appleTime();
  const body = b64(JSON.stringify({ iss: issuer, iat: now, exp: now + 900, aud: 'appstoreconnect-v1' }));
  const key = createPrivateKey(readFileSync(path.join(dir, `AuthKey_${KEY_ID}.p8`)));
  const sig = sign('sha256', Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' });
  return `${head}.${body}.${b64(sig)}`;
}
async function get(p) {
  const r = await fetch(`${API}${p}`, { headers: { Authorization: `Bearer ${await token()}` } });
  noteDate(r);
  const text = (await r.text()).split(issuer).join('<issuer-id>');
  if (!r.ok) {
    console.error(`asc: GET ${p.split('?')[0]} answered ${r.status}: ${text.slice(0, 400)}`);
    process.exit(2);
  }
  return JSON.parse(text);
}
async function post(p, bodyObj) {
  const r = await fetch(`${API}${p}`, { method: 'POST', headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' }, body: JSON.stringify(bodyObj) });
  noteDate(r);
  const text = (await r.text()).split(issuer).join('<issuer-id>');
  return { status: r.status, text };
}
async function app() {
  const j = await get(`/v1/apps?filter[bundleId]=${BUNDLE_ID}`);
  const a = j.data[0];
  if (!a) {
    console.error(`asc: no app record with bundle id ${BUNDLE_ID}`);
    process.exit(2);
  }
  return a.id;
}
async function builds(appId) {
  const j = await get(`/v1/builds?filter[app]=${appId}&limit=50&sort=-uploadedDate&include=buildBetaDetail&fields[builds]=version,processingState,uploadedDate,expired,usesNonExemptEncryption,buildBetaDetail`);
  const detail = new Map((j.included ?? []).filter((x) => x.type === 'buildBetaDetails').map((x) => [x.id, x.attributes]));
  return j.data.map((b) => {
    const known = detail.get(b.relationships?.buildBetaDetail?.data?.id);
    const d = known ?? {};
    // F-1404: a listed build whose beta detail is missing from the answer is a PARTIAL read, not "no internal state".
    return { partial: known === undefined, id: b.id, version: b.attributes.version, processing: b.attributes.processingState, expired: b.attributes.expired, encryption: b.attributes.usesNonExemptEncryption,
      uploaded: b.attributes.uploadedDate, internal: d.internalBuildState ?? null, external: d.externalBuildState ?? null, autoNotify: d.autoNotifyEnabled ?? null };
  });
}
const AVAILABLE = new Set(['READY_FOR_BETA_TESTING', 'IN_BETA_TESTING']);
async function readback(appId, version) {
  const b = (await builds(appId)).find((x) => x.version === version);
  if (!b) return { ok: false, line: `build ${version}: not listed yet`, failed: false };
  const gs = (await get(`/v1/betaGroups?filter[builds]=${b.id}&fields[betaGroups]=name,isInternalGroup`)).data;
  const groups = gs.map((g) => `${g.attributes.name}${g.attributes.isInternalGroup ? ' (internal)' : ''}`);
  const inInternalGroup = gs.some((g) => g.attributes.isInternalGroup === true);
  const failed = b.processing === 'INVALID' || b.processing === 'FAILED';
  // F-1404: Apple listed the build without its buildBetaDetail: the state is unknown, never reported as "NOT available" (exit 2, not 1).
  const ok = !b.partial && b.processing === 'VALID' && !b.expired && AVAILABLE.has(b.internal) && inInternalGroup;
  return { ok, failed, partial: b.partial, line: `build ${b.version}: processing ${b.processing}, internalBuildState ${b.partial ? 'unknown (not in the answer)' : b.internal}, expired ${b.expired}, usesNonExemptEncryption ${b.encryption}, uploaded ${b.uploaded}, groups [${groups.join(', ')}]` };
}

const GROUP_NAME = 'Owner';
/** F-1366, F-1390: the build's record once App Store Connect lists it AND has finished processing (VALID), read every STEP_MS; INVALID or FAILED exits 1;
 * not listed or not VALID by the cap, exit 1 (nothing was written). The only add Apple has been seen to accept came after VALID. */
async function listedBuild(appId, version) {
  const cap = capTimer();
  for (;;) {
    const b = (await builds(appId)).find((x) => x.version === version);
    if (b && b.processing === 'VALID') return b;
    if (b && (b.processing === 'INVALID' || b.processing === 'FAILED')) {
      console.error(`asc: build ${version} processing ${b.processing}; nothing written`);
      process.exit(1);
    }
    if (cap.capped) {
      console.error(`asc: build ${version} ${b ? `still processing (${b.processing})` : 'still not listed'} after ${Math.round(CAP_MS / 60_000)} minutes (cap); nothing written`);
      process.exit(1);
    }
    console.log(`asc: build ${version}: ${b ? `processing ${b.processing}` : 'not listed yet'}, reading again in ${Math.round(STEP_MS / 1000)} s`);
    await pause();
  }
}

async function addToGroup(appId, version) {
  const b = await listedBuild(appId, version);
  const gs = (await get(`/v1/betaGroups?filter[app]=${appId}&filter[name]=${GROUP_NAME}&filter[isInternalGroup]=true&limit=10`)).data
    .filter((g) => g.attributes.name === GROUP_NAME && g.attributes.isInternalGroup === true);
  if (gs.length !== 1) {
    console.error(`asc: expected exactly 1 internal group named ${GROUP_NAME}, found ${gs.length}; nothing written`);
    process.exit(2);
  }
  const r = await post(`/v1/betaGroups/${gs[0].id}/relationships/builds`, { data: [{ type: 'builds', id: b.id }] });
  console.log(`asc: POST /v1/betaGroups/<${GROUP_NAME}>/relationships/builds for build ${version} answered HTTP ${r.status}`);
  if (r.status !== 204) {
    console.error(`asc: ${r.text.slice(0, 400)}`);
    process.exit(2);
  }
}

const [cmd, version] = process.argv.slice(2);
const appId = await app();
if (cmd === 'builds') {
  for (const b of await builds(appId)) console.log(`version ${b.version} processing ${b.processing} internal ${b.internal} expired ${b.expired} uploaded ${b.uploaded}`);
} else if (cmd === 'readback' && version) {
  const r = await readback(appId, version);
  console.log(`asc: ${r.line}`);
  if (r.partial) {
    console.log("asc: App Store Connect answered without the build's beta state (partial answer); read again");
    process.exit(2);
  }
  console.log(r.ok ? 'asc: AVAILABLE to internal testers' : 'asc: NOT available to internal testers');
  process.exit(r.ok ? 0 : 1);
} else if (cmd === 'add-to-group' && version) {
  await addToGroup(appId, version);
} else if (cmd === 'wait' && version) {
  const cap = capTimer();
  for (;;) {
    const r = await readback(appId, version);
    console.log(`asc: ${r.line}`);
    if (r.ok) process.exit(0);
    if (r.failed) process.exit(1);
    if (cap.capped) process.exit(r.partial ? 2 : 1);
    await pause();
  }
} else {
  console.error('usage: asc.mjs builds | readback <version> | add-to-group <version> | wait <version>');
  process.exit(2);
}
