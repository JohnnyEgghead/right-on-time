// SPDX-License-Identifier: AGPL-3.0-or-later
// Vitest setup file for G-CI7's kernel steps (ci/gates/G-CI7/vitest.config.ts and vitest.db.config.ts): installs the F-683 guard on fetch.
import { guardedFetch } from './outside-fetch-guard.ts';

globalThis.fetch = guardedFetch(globalThis.fetch);
