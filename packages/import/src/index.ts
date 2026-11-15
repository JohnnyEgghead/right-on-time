// SPDX-License-Identifier: AGPL-3.0-or-later
// @bw/import (SPECIFICATIONS section 6.7, SD-24; FR-IMP-1 to FR-IMP-4, FR-IMP-6): the import runner (parse, validate,
// match, write; the dry run), the exact-duplicate merges, their undo and the office's pair decisions.
export { CUSTOMER_COLUMNS, EQUIPMENT_COLUMNS, EXPORT_FILES, LayoutError, parseExport, VISIT_COLUMNS, type ExportFile, type ExportFiles, type ParsedExport } from './layout.ts';
export { buildModel, DataError, matchInputs, modelOf, PROBLEM_REASONS, toE164, type ImportCounts, type ImportModel, type ImportReference, type ProblemReason } from './model.ts';
export { blockingKeys, exactKey, LIKELY_THRESHOLD, likelyWhy, matchCustomers, WHY_FIELDS, type MatchCustomer, type MatchPair, type PairWhy } from './match.ts';
export { jaroWinkler, nameScore } from './similarity.ts';
export {
  decidePair, importRunMover, LockOrderRetry, mergePair, MergeRefused, undoMerge, type HeldDay, type JobMove, type JobMover, type PairDecision, type UndoPayload,
} from './merge.ts';
export { newInboxTokens, newLinkToken, writeModel } from './write.ts';
export {
  failureCode, ImportRefused, ImportRunFailed, loadReference, MAX_RUN_ATTEMPTS, reportOf, requestImportRun, runImport, runPendingImport,
  type Connection, type Connector, type ImportReport, type PendingOptions, type RunAttempts, type RunClock, type RunKind, type RunOptions,
  type RunOutcome, type RunRequest,
} from './runner.ts';
export { readExport } from './files.ts';
