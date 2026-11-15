// SPDX-License-Identifier: AGPL-3.0-or-later
export { catalogs } from './catalog.ts';
export type { MessageKey } from './catalog.ts';
export { serializeCatalog, parseCatalog } from './catalog-format.ts';
export type { CatalogMap } from './catalog-format.ts';
export { chooseLanguage, isLanguage, LANGUAGES } from './language.ts';
export type { Language, LanguageInputs, LanguageSurface } from './language.ts';
export { checkParity, checkCatalogFiles, SAME_VALUE_ALLOWLIST } from './parity.ts';
export { BwIntlProvider, createBwIntl, isTestBuild, makeOnError } from './provider.tsx';
export { installIntlPolyfills } from './polyfills.ts';
export { leftChipText, leftHowText, leftReasonText, shortName, waitingReasonText } from './billing-rows.ts';
export type { LeftWords, RowT, WaitingWords } from './billing-rows.ts';
export {
  clockOfWire, contextLine, handlingChip, handlingNote, hourWordOfWire, languageText, reasonText, statusChip, statusLine, statusNote, TYPE_NAMES, typeText,
  windowLabelOfWire,
} from './text-rows.ts';
export type { ChipTone, ReplyHandlingName, StatusFacts, TextStatusName, TimeWords } from './text-rows.ts';
export { formatterFor } from './format.ts';
export { stepDistanceText, stepText } from './step-words.ts';
export type { StepWords } from './step-words.ts';
