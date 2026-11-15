// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-OFC-05 and SCR-OFC-38 in each state their frames show, with fixed data and no handlers that do anything: client wrappers for the
// harness preview routes (a server page cannot pass functions to a client component). Harness build only; a release route never imports it.
import { CustomerFormDialog } from './CustomerFormDialog.tsx';
import { NO_FILTERS, type SearchFilters } from './model.ts';
import { NEW_FORM, NO_MATCH_FORM, RESULTS, SEAN_DETAIL } from './preview-data.ts';
import { SearchView, type PreviewState, type SearchPhase } from './SearchView.tsx';
import { EMPTY_FORM } from './model.ts';

const noop = () => undefined;

export type SearchPreviewState =
  | 'results' | 'empty' | 'searching' | 'preview-loading' | 'preview-error' | 'none' | 'error' | 'new-empty' | 'new-nomatch' | 'new-saving';

export function SearchPreview({ state, solo = false }: { state: SearchPreviewState; solo?: boolean }) {
  const phase: SearchPhase = state === 'empty' ? 'empty' : state === 'searching' ? 'searching' : state === 'none' ? 'none' : state === 'error' ? 'error' : 'results';
  const filters: SearchFilters = state === 'none' ? { ...NO_FILTERS, plan: 'comfort_club' } : { ...NO_FILTERS, branch: 'columbus' };
  const preview: PreviewState = state === 'preview-loading' ? { kind: 'loading' } : state === 'preview-error' ? { kind: 'error' } : phase === 'results' ? { kind: 'ready', data: SEAN_DETAIL } : { kind: 'none' };
  const query = state === 'empty' ? '' : state === 'none' ? 'hendrix' : 'obrien';
  return (
    <>
      <SearchView
        phase={phase} query={query} filters={filters} page={phase === 'results' ? RESULTS : null} allTotal={18400} homeBranch="columbus" cities={RESULTS.cities} selectedId={phase === 'results' ? RESULTS.customers[0]?.id ?? null : null}
        preview={preview} jobs={state === 'results' ? { kind: 'found', rows: [{ jobNumber: 24866, customer: "Sean O'Brien", service: 'furnace_tune_up', day: '2026-09-17' }] } : null} onQuery={noop} onFilters={noop} onClear={noop} onClearFilters={noop} onSelect={noop} onMore={noop} onRetry={noop} onRetryPreview={noop} onNew={noop} onNewJob={noop}
      />
      {state === 'new-empty' ? <CustomerFormDialog mode="new" initial={EMPTY_FORM} onClose={noop} onSaved={noop} inline solo={solo} /> : null}
      {state === 'new-nomatch' ? <CustomerFormDialog mode="new" initial={NO_MATCH_FORM} onClose={noop} onSaved={noop} inline frozen="no-street-match" solo={solo} /> : null}
      {state === 'new-saving' ? <CustomerFormDialog mode="new" initial={NEW_FORM} onClose={noop} onSaved={noop} inline frozen="saving" solo={solo} /> : null}
    </>
  );
}
