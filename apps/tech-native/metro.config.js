// SPDX-License-Identifier: AGPL-3.0-or-later
// Metro for the native app: Expo's defaults (the monorepo is detected), with 1 change. Expo resolves the module that serves a dynamic
// import() (expo/internal/async-require-module) through this app's node_modules symlink; the license gate (ci/license-gates.ts) names
// each bundled file's package from its real pnpm path, so the module is given by its real path (P6-NATIVE-SHELL: the Intl polyfills
// load by dynamic import, F-141).
/* eslint-disable @typescript-eslint/no-require-imports -- Metro loads this file as CommonJS */
const { realpathSync } = require('node:fs');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
if (config.transformer.asyncRequireModulePath) {
  config.transformer.asyncRequireModulePath = realpathSync(require.resolve(config.transformer.asyncRequireModulePath, { paths: [__dirname] }));
}
module.exports = config;
