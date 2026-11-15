// SPDX-License-Identifier: AGPL-3.0-or-later
// F-1621 (owner answer dedc3b70, "Keep them private"): the owner's Apple ids for the iOS release, the team id (BW_APPLE_TEAM_ID) and the
// App Store Connect API key id (BW_ASC_KEY_ID), are not written in any exported file. Each comes from the environment, else from the owner's
// private file: $BW_OWNER_ENV (default infra/owner.env), then $BW_OWNER_ENV_LOCAL (default infra/owner.local.env). The export leaves both
// files out (scripts/private-paths.txt), so a public copy has none and gives its own ids in the environment.
// The file rules are infra/drill/owner-env.sh's: KEY=VALUE lines with KEY starting BW_ (capitals, digits, _); # comments and blank lines
// skipped; no quotes, no expansion; a variable set in the environment wins over the files. Nothing here prints a value.
// Used by app.config.js (the team id) and release/asc.mjs (the key id).
'use strict';
/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS on purpose: app.config.js loads it with require, as expo prebuild loads that */
const { existsSync, readFileSync } = require('node:fs');
const path = require('node:path');

/** The repo root: this file is apps/tech-native/release/owner-env.cjs. */
const ROOT = path.resolve(__dirname, '..', '..', '..');
/** An Apple team id and an App Store Connect key id are each 10 capitals or digits. */
const APPLE_ID = /^[A-Z0-9]{10}$/;

/** The owner files, in the order they are read. */
function ownerFiles(env = process.env, root = ROOT) {
  return [env.BW_OWNER_ENV || path.join(root, 'infra', 'owner.env'), env.BW_OWNER_ENV_LOCAL || path.join(root, 'infra', 'owner.local.env')];
}

/** The BW_ lines of 1 owner file (empty when the file is absent); the first line for a key wins, as the shell helper's does. */
function readOwnerFile(file) {
  const out = new Map();
  if (!existsSync(file)) return out;
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw; // F-1686: a CRLF file's carriage return is not part of the value
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue; // a line without = is skipped, as owner-env.sh skips it
    const k = line.slice(0, eq);
    if (!/^BW_[A-Z0-9_]+$/.test(k) || out.has(k)) continue;
    out.set(k, line.slice(eq + 1));
  }
  return out;
}

/** The value of `key`: the environment's when set (even empty), else the first owner file's that holds it; undefined when none does. */
function ownerValue(key, env = process.env, root = ROOT) {
  if (Object.prototype.hasOwnProperty.call(env, key)) return env[key];
  for (const f of ownerFiles(env, root)) {
    const v = readOwnerFile(f).get(key);
    if (v !== undefined) return v;
  }
  return undefined;
}

/**
 * The Apple id under `key`, or null when it is unset or empty. A set value that is not 10 capitals or digits throws (the message names
 * the key, never the value), so a typo is never taken for an id.
 */
function ownerAppleId(key, env = process.env, root = ROOT) {
  const v = ownerValue(key, env, root);
  if (v === undefined || v === '') return null;
  if (!APPLE_ID.test(v)) throw new Error(`${key} is set but is not 10 capitals or digits (the value is not printed)`);
  return v;
}

module.exports = { ROOT, APPLE_ID, ownerFiles, readOwnerFile, ownerValue, ownerAppleId };
