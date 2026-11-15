// SPDX-License-Identifier: AGPL-3.0-or-later
// Photos on a job before StepsUITests runs (P6-NATIVE-STEPS; run.sh): each JPEG sent to API-103 as Maria Santos's web app sends a photo
// (PUT /api/v1/tech/photos/<key>?kind=photo&..., her web session's cookie and the app's origin), so the job holds them as stored photos with
// their small copies (SD-32, UD-55), the state SCR-TEC-04's Success frame shows: Photos (3) over a strip that scrolls past the 2 in view.
//   BW_SEED_TOKEN=<her web session token> BW_CLOCK_TOKEN=<an office web session token> BW_REAL_NOW=<wire time> node xcuitest/seed-photos.mjs <base url> <app origin> <job number> <photo.jpg>...
// (the demo clock, API-10, is read with the office session, as ci/tech-job-stack/photo-thumbs.stack.ts reads it)
// Prints 1 line per photo: "<key> <result>"; exit 1 when API-103 does not apply one.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const [base, origin, job, ...files] = process.argv.slice(2);
const token = process.env.BW_SEED_TOKEN ?? '';
if (!base || !origin || !job || files.length === 0 || !token) {
  console.error('usage: BW_SEED_TOKEN=<token> seed-photos.mjs <base url> <app origin> <job number> <photo.jpg>...');
  process.exit(2);
}
const headers = { cookie: `bw_session=${token}; bw_lang=en`, origin, accept: 'application/json' };
// The device and saved real times are the run's own (run.sh passes them: no wall clock is read here, FR-DEMO-2's lint covers apps/).
const runTime = process.env.BW_REAL_NOW ?? '';
if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00\[UTC\]$/.test(runTime)) {
  console.error('seed-photos: BW_REAL_NOW must be a wire time like 2026-11-10T15:00:00+00:00[UTC]');
  process.exit(2);
}
const clockAnswer = await fetch(`${base}/api/v1/clock`, { headers: { ...headers, cookie: `bw_session=${process.env.BW_CLOCK_TOKEN ?? ''}; bw_lang=en` } });
if (clockAnswer.status !== 200) {
  console.error(`seed-photos: the clock read answered ${clockAnswer.status}`);
  process.exit(1);
}
const clock = await clockAnswer.json();
let failed = 0;
for (const f of files) {
  const key = randomUUID();
  const q = new URLSearchParams({
    kind: 'photo', jobNumber: job, worldEpoch: String(clock.data.worldEpoch), deviceTime: runTime, offsetSavedReal: runTime, sinceSaveMs: '0', demoTime: clock.data.demoNow,
  });
  const r = await fetch(`${base}/api/v1/tech/photos/${key}?${q}`, { method: 'PUT', headers: { ...headers, 'content-type': 'image/jpeg' }, body: readFileSync(f) });
  const a = await r.json().catch(() => ({}));
  const result = r.status === 200 ? a.data?.result : `status ${r.status} ${a.code ?? ''}`;
  console.log(`${key} ${result}`);
  if (result !== 'applied') failed += 1;
}
process.exit(failed === 0 ? 0 : 1);
