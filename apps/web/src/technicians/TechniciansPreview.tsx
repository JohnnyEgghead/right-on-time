// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// Harness build only (imported by app/shell-preview/technicians/[state]/page.preview.tsx): SCR-OFC-07, -41 and -42 in each state DK-92 draws, on the
// frame's own Columbus day (tech-fixtures.ts), for the look comparator (ci/look-values/technicians.pw.test.ts) and the page walkers. Each state is
// fixed: the reads answer the frame's data, a write never answers, there is no live stream.
import { Suspense, type ReactNode } from 'react';
import { HostedScreenAttr } from '../board/Dialogs.tsx';
import { windowText } from '../board/model.ts';
import { ToastView } from '../shell/Announcer.tsx';
import { OfficeFrame } from '../shell/Frames.tsx';
import { useT } from '../shell/intl.tsx';
import { APP_INFO, CLOCK_RUNNING, MANAGER } from '../shell/preview-fixtures.ts';
import { wireAt } from '../board/preview-fixtures.ts';
import type { Answer, TechApi } from './api.ts';
import { AddTechnicianDialog, AddTimeOffDialog } from './Dialogs.tsx';
import { draftOf, jobsText, NO_FILTERS, type DraftEdit, type Filters, type NameCheckState, type TechData, type TechSkill } from './model.ts';
import { DOYLE, MARIA, SKILL_WORDS, TECH_EMPTY, TECH_SUCCESS, TECH_TIMEOFF_REMOVED, TECH_TIMEOFF_SAVED, type TechPreviewState } from './tech-fixtures.ts';
import { TechniciansView, type TechViewProps } from './TechniciansView.tsx';

const FRAME = { clock: CLOCK_RUNNING, appInfo: APP_INFO, reader: false } as const;
const never = <T,>(): Promise<Answer<T>> => new Promise(() => undefined);
/** The calls of a preview: reads answer the frame's data, a write never answers. */
const previewApi = (): TechApi => ({
  list: async () => ({ ok: true, data: TECH_SUCCESS }),
  check: () => never(),
  edit: () => never(),
  add: () => never(),
  addTimeOff: () => never(),
  removeTimeOff: () => never(),
});

/** The screen each solo state draws alone (the page walkers' dialog rows: exactly 1 screen root). */
export const SOLO_SCREEN: Partial<Record<TechPreviewState, string>> = { 'add-editing': 'SCR-OFC-41', 'add-hours': 'SCR-OFC-41', 'timeoff-editing': 'SCR-OFC-42' };

const PAGE_STATES: ReadonlySet<TechPreviewState> = new Set(['success', 'loading', 'error', 'empty', 'no-match', 'checking', 'problem', 'saved', 'time-off-removed', 'time-off-saved', 'app-offline', 'hours-editing', 'hours-problem']);

const PROBLEM = { ok: false, problem: 'not_gsm7_basic' as const, characters: ['ó'], length: 5, maximum: 10 };
const base = (): TechViewProps => ({
  state: 'ready', data: TECH_SUCCESS, branch: 'columbus', filters: { ...NO_FILTERS, working: 'today' }, selectedId: MARIA.id, draft: draftOf(MARIA), check: { step: 'idle' }, words: SKILL_WORDS,
});

function Hosted({ state }: { state: TechPreviewState }): ReactNode {
  const t = useT();
  const api = previewApi();
  const common = { api, data: { ...TECH_SUCCESS, skills: ['plumbing', 'drains', 'water_heaters'] as TechSkill[] }, branch: 'columbus', words: SKILL_WORDS, onClose: () => undefined, inline: true };
  const tf = { api, row: MARIA, onClose: () => undefined, inline: true };
  switch (state) {
    case 'saved': return <ToastView text={t('technicians.saved')} />;
    case 'time-off-removed': return <ToastView text={t('technicians.timeOff.removed')} />;
    case 'time-off-saved':
      return <ToastView text={t('technicians.timeOff.savedJobs', {
        name: 'Maria', count: 1, when: t('technicians.timeOff.whenDay'),
        jobs: jobsText([{ jobNumber: 24903, window: { start: wireAt(10), end: wireAt(12) } }], t, windowText),
      })} />;
    case 'add-editing': return <AddTechnicianDialog {...common} start={{ focus: true }} />;
    case 'add-hours': return <AddTechnicianDialog {...common} start={{ hoursOpen: true }} />;
    case 'add-saving': return <AddTechnicianDialog {...common} start={{ name: 'Derek Lindgren', email: 'dlindgren@brightwaterair.com', vanId: TECH_SUCCESS.vans[0]?.id ?? null, skills: ['plumbing', 'drains'] as TechSkill[], saving: true }} />;
    case 'add-added': return <AddTechnicianDialog {...common} start={{ added: { name: 'Derek Lindgren', email: 'dlindgren@brightwaterair.com', link: '/email/preview' } }} />;
    case 'add-used': return <AddTechnicianDialog {...common} start={{ added: { name: 'Derek Lindgren', email: 'dlindgren@brightwaterair.com', link: '/email/preview' }, used: true }} />;
    case 'timeoff-editing': return <AddTimeOffDialog {...tf} />;
    case 'timeoff-saving': return <AddTimeOffDialog {...tf} start={{ from: '2026-09-21', to: '2026-09-21', note: 'Dentist', saving: true }} />;
    default: return null;
  }
}

/** The page's own state of each page-level preview state (the rest draw the Success page with a hosted dialog or toast over it). */
function pageOf(state: TechPreviewState): TechViewProps {
  const b = base();
  const draft = (name: string): DraftEdit => ({ ...(b.draft as DraftEdit), name });
  const checking: NameCheckState = { step: 'checking' };
  switch (state) {
    case 'loading': return { ...b, state: 'loading', data: null, selectedId: null, draft: null };
    case 'error': return { ...b, state: 'error', data: null, selectedId: null, draft: null };
    case 'empty': return { ...b, data: TECH_EMPTY, branch: 'springfield', selectedId: null, draft: null };
    case 'no-match': return { ...b, filters: { ...NO_FILTERS, skill: 'boilers', working: 'off' } as Filters, selectedId: null, draft: null };
    case 'checking': return { ...b, draft: draft('Ramón'), check: checking };
    case 'problem': return { ...b, draft: draft('Ramón'), check: { step: 'done', answer: PROBLEM } };
    case 'saved': return withName(b, 'Ramon');
    case 'time-off-removed': return { ...b, data: TECH_TIMEOFF_REMOVED };
    case 'time-off-saved': return { ...b, data: TECH_TIMEOFF_SAVED };
    case 'app-offline': return { ...b, selectedId: DOYLE.id, draft: draftOf(DOYLE) };
    case 'hours-editing': return { ...b, draft: { ...(b.draft as DraftEdit), hoursOpen: true, week: { ...(b.draft as DraftEdit).week, days: [1, 2, 3, 4] } } };
    case 'hours-problem': return { ...b, draft: { ...(b.draft as DraftEdit), hoursOpen: true, week: { ...(b.draft as DraftEdit).week, end: '07:00' } } };
    default: return b;
  }
}

/** The Saved state: Maria's name in texts is the one just saved. */
function withName(b: TechViewProps, name: string): TechViewProps {
  const data: TechData = { ...TECH_SUCCESS, technicians: TECH_SUCCESS.technicians.map((r) => (r.id === MARIA.id ? { ...r, nameInTexts: name } : r)) };
  return { ...b, data, draft: { ...(b.draft as DraftEdit), name } };
}

export function TechniciansPreview({ state, solo = false }: { state: TechPreviewState; solo?: boolean }) {
  const soloScreen = solo ? SOLO_SCREEN[state] : undefined;
  if (soloScreen) {
    return (
      <HostedScreenAttr.Provider value={false}>
        <OfficeFrame screen={soloScreen} me={MANAGER} {...FRAME}>
          <div className="bw-hosted" data-bw-hosted={state}><Hosted state={state} /></div>
        </OfficeFrame>
      </HostedScreenAttr.Provider>
    );
  }
  const page = pageOf(state);
  const toast = state === 'saved' || state === 'time-off-removed' || state === 'time-off-saved';
  const hosted = PAGE_STATES.has(state) && !toast ? null : <div className="bw-hosted" data-bw-hosted={state}><Hosted state={state} /></div>;
  return (
    <OfficeFrame screen="SCR-OFC-07" me={MANAGER} {...FRAME} bar={{ alertCount: 2, currentPath: '/office/technicians' }}>
      <Suspense>
        <TechniciansView {...page} extra={hosted} />
      </Suspense>
    </OfficeFrame>
  );
}
