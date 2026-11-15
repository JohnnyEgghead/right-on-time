// SPDX-License-Identifier: AGPL-3.0-or-later
// F-1073: puts the native map's glyph and sprite folder (apps/web/src/map/assets, the set P3-MAP-LABELS committed with its licenses) into the
// generated iOS project, as the app bundle's folder map-assets/ (fonts/ and sprites/ inside, the paths src/screens/mapme/map-style.ts names).
// It runs inside "expo prebuild", so every build of the generated project has the set, the XCUITest rig's and the TestFlight archive's alike.
// A missing or empty set stops the prebuild with the reason: without it the map draws with no street, place or water names and nothing says so.
/* eslint-disable @typescript-eslint/no-require-imports -- an Expo config plugin is CommonJS: expo prebuild loads it with require */
const fs = require('node:fs');
const path = require('node:path');
const { withDangerousMod, withXcodeProject } = require('expo/config-plugins');

const SOURCE = path.resolve(__dirname, '../../web/src/map/assets');
const NAME = 'map-assets';

function files(dir) {
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => !f.startsWith('.')) : [];
}

/** Throws unless the source holds fonts/ with a 0-255.pbf in each font stack folder, and sprites/ with light.json and light.png (F-1411: as check-seams.py checks the archive). */
function checkSource(source) {
  const fail = (what) => {
    throw new Error(`with-map-assets: ${what}; the native map would draw with no names. Restore apps/web/src/map/assets.`);
  };
  const fonts = path.join(source, 'fonts');
  const stacks = files(fonts).filter((f) => fs.statSync(path.join(fonts, f)).isDirectory());
  if (stacks.length === 0) fail(`${fonts} holds no font stack folder`);
  for (const stack of stacks) {
    if (!fs.existsSync(path.join(fonts, stack, '0-255.pbf'))) fail(`${path.join(fonts, stack, '0-255.pbf')} is missing`);
  }
  for (const f of ['light.json', 'light.png']) {
    if (!fs.existsSync(path.join(source, 'sprites', f))) fail(`${path.join(source, 'sprites', f)} is missing`);
  }
}

module.exports = function withMapAssets(config) {
  config = withDangerousMod(config, [
    'ios',
    (c) => {
      checkSource(SOURCE);
      const dest = path.join(c.modRequest.platformProjectRoot, NAME);
      fs.rmSync(dest, { recursive: true, force: true });
      fs.cpSync(SOURCE, dest, { recursive: true });
      return c;
    },
  ]);
  return withXcodeProject(config, (c) => {
    const project = c.modResults;
    const target = project.getFirstTarget();
    // A folder reference: the whole folder lands in the app as <app>.app/map-assets/.
    project.addResourceFile(NAME, { lastKnownFileType: 'folder', target: target.uuid });
    return c;
  });
};
module.exports.checkSource = checkSource;
