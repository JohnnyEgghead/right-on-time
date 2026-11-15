// SPDX-License-Identifier: AGPL-3.0-or-later
// Project ESLint rules (SPECIFICATIONS section 14); eslint.config.mjs scopes each to its files.
import noInlineStrings from './no-inline-strings.mjs';
import noSystemClock from './no-system-clock.mjs';
import logAllowlist from './log-allowlist.mjs';

export default {
  rules: {
    'no-system-clock': noSystemClock,
    'no-inline-strings': noInlineStrings,
    'log-allowlist': logAllowlist,
  },
};
