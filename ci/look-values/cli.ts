// SPDX-License-Identifier: AGPL-3.0-or-later
// CLI for the look-values comparator. See README.md in this folder.
//   node ci/look-values/cli.ts --app <url> --frame <path> [--state <name>] --pair <sel> [--frame-pair <frameSel>] ...
//   node ci/look-values/cli.ts --kit-sheet <appCopy>=<kitFile> ...
// Exit 0: no difference. Exit 1: a difference. Exit 2: bad usage.
import { parseArgs } from 'node:util';
import { compareKitSheets, compareLook, formatDifferences, type SelectorPair } from './compare.ts';

const { values } = parseArgs({
  options: {
    app: { type: 'string' },
    frame: { type: 'string' },
    state: { type: 'string' },
    pair: { type: 'string', multiple: true },
    'frame-pair': { type: 'string', multiple: true },
    'kit-sheet': { type: 'string', multiple: true },
    json: { type: 'boolean' },
  },
});

const USAGE = [
  'usage: cli.ts --app <url> --frame <path> [--state <name>] --pair <sel> [--frame-pair <frameSel>] ... [--json]',
  '       cli.ts --kit-sheet <appCopy>=<kitFile> ...',
];
const usage = (why?: string): never => {
  if (why) console.error(why);
  for (const l of USAGE) console.error(l);
  process.exit(2);
};

const sheets = values['kit-sheet'] ?? [];
// A selector may contain = (an attribute selector such as [data-ctl="X"]), so --pair is never split. The frame
// selector comes from its own flag, matched to --pair by position (an empty --frame-pair means the same selector).
const appSels = values.pair ?? [];
const frameSels = values['frame-pair'] ?? [];
if (frameSels.length !== 0 && frameSels.length !== appSels.length) {
  usage(`--frame-pair given ${frameSels.length} time(s) for ${appSels.length} --pair(s); give one per --pair or none`);
}
const pairs: SelectorPair[] = appSels.map((app, i) => (frameSels[i] ? { app, frame: frameSels[i] } : { app }));

if (!sheets.length && !(values.app && values.frame && pairs.length)) usage();
for (const s of sheets) {
  if (!s.includes('=')) usage(`--kit-sheet needs <appCopy>=<kitFile>, got: ${s}`);
}

let failed = false;

if (sheets.length) {
  const bad = compareKitSheets(
    sheets.map((s) => {
      const i = s.indexOf('=');
      return { app: s.slice(0, i), kit: s.slice(i + 1) };
    }),
  );
  for (const b of bad) console.log(`DIFF kit-sheet ${b.app} vs ${b.kit}: ${b.reason}`);
  if (bad.length) failed = true;
  else console.log(`PASS ${sheets.length} kit sheet(s) identical`);
}

if (values.app && values.frame && pairs.length) {
  const r = await compareLook({ appUrl: values.app, framePath: values.frame, ...(values.state ? { state: values.state } : {}), pairs });
  console.log(values.json ? JSON.stringify(r, null, 2) : formatDifferences(r));
  if (r.differences.length) failed = true;
}

process.exit(failed ? 1 : 0);
