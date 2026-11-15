// SPDX-License-Identifier: AGPL-3.0-or-later
// What StepsUITests expects Directions to show for 1 baked leg (P6-NATIVE-STEPS; run.sh): the leg's stored steps (world.van_track.steps,
// JSON on stdin) worded by P6-ROUTE-BAKE's shared function (@bw/i18n step-words.ts) in 1 language, as the app words them.
//   node xcuitest/steps-expect.mjs <en|es> <street address>     prints 6 lines:
//     the steps' words, in driving order, joined by |
//     the steps' distances, the arrival's empty, joined by |
//     the Next turn card's words ("<In 50 ft:> <the second step's words>")
//     the second step's turn point "lon,lat" (the next-turn marker), the third step's (the step the test picks)
//     the sum of the steps' meters
import { readFileSync } from 'node:fs';
import { formatterFor } from '../../../packages/i18n/src/format.ts';
import { stepDistanceText, stepText } from '../../../packages/i18n/src/step-words.ts';

const [lang, street] = process.argv.slice(2);
if ((lang !== 'en' && lang !== 'es') || !street) {
  console.error('usage: steps-expect.mjs <en|es> <street address>  (steps JSON on stdin)');
  process.exit(2);
}
const steps = JSON.parse(readFileSync(0, 'utf8'));
if (!Array.isArray(steps) || steps.length < 3) {
  console.error(`steps-expect: ${Array.isArray(steps) ? steps.length : 'no'} steps; the test needs a leg of 3 or more`);
  process.exit(1);
}
const t = formatterFor(lang);
const words = steps.map((s) => stepText(s, t, street));
if (words.some((w) => w === null)) {
  console.error('steps-expect: a step has no words');
  process.exit(1);
}
const at = (s) => `${s.at[0]},${s.at[1]}`;
console.log(words.join('|'));
console.log(steps.map((s) => (s.kind === 'arrive' ? '' : stepDistanceText(s.distanceMeters, t))).join('|'));
console.log(`${t('tech.dir.nextTurnIn', { distance: stepDistanceText(steps[0].distanceMeters, t) })} ${words[1]}`);
console.log(at(steps[1]));
console.log(at(steps[2]));
console.log(String(steps.reduce((n, s) => n + s.distanceMeters, 0)));
