// SPDX-License-Identifier: AGPL-3.0-or-later
// The native app's catalog (F-1199; FR-IOS-4, SPECIFICATIONS 6.12): only the keys native code can show, with their en and es values.
// catalog-native.json is generated, never edited by hand: node ci/native/catalog-subset.ts --write derives it from the native import
// graph, and --check (with its test, ci/native/catalog-subset.test.ts) fails when it drifts or when code names a key the derivation
// cannot see. The words themselves stay in packages/i18n/catalog (the one place they are written).
import type { Catalogs } from '@bw/i18n/src/provider-core.tsx';
import subset from './catalog-native.json' with { type: 'json' };

export const nativeCatalogs: Catalogs = subset;
