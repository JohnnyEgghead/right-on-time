// SPDX-License-Identifier: AGPL-3.0-or-later
// The Expo config: app.json, plus the owner's Apple team id (F-1621; owner answer dedc3b70, "Keep them private"). The team id is not in
// any exported file: it comes from BW_APPLE_TEAM_ID in the environment or the owner's private file (release/owner-env.cjs).
// A release project (BW_RELEASE=1, set by xcuitest/prebuild.sh --release) is signed with that team, so it refuses to resolve without it.
// Any other project (the simulator rig, which add-uitests.rb builds unsigned; a public copy; a test) resolves without one, and gets it
// when it is there, as before.
/* eslint-disable @typescript-eslint/no-require-imports -- an Expo config file is CommonJS: expo prebuild loads it with require */
const { ownerAppleId } = require('./release/owner-env.cjs');

module.exports = ({ config }) => {
  const team = ownerAppleId('BW_APPLE_TEAM_ID');
  if (team === null) {
    if (process.env.BW_RELEASE === '1') {
      throw new Error(
        'app.config: BW_RELEASE=1 needs the Apple team id. Set BW_APPLE_TEAM_ID in the environment, or put the line BW_APPLE_TEAM_ID=<team id> in the owner\'s private file (release/owner-env.cjs reads it; F-1621).',
      );
    }
    return config;
  }
  return { ...config, ios: { ...config.ios, appleTeamId: team } };
};
