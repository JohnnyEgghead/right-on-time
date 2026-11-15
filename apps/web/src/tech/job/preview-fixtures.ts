// SPDX-License-Identifier: AGPL-3.0-or-later
// Harness build only (the shell-preview routes tech-job, tech-note, tech-finish, tech-waiting): Harold Jenkins's Sep 15 job 24830
// as DK-110 to DK-112 draw it, and the engine states of their frames. A photo here is the frame's own picture, served as a data URL
// (PREVIEW_FILES; the preview has no stored file).
import type { AnsweredItem, QueuedItem } from '@bw/outbox/src/items/index.ts';
import type { OutboxState } from '../engine.ts';
import type { FinishDraft, JobCopy, Part } from './store.ts';

const z = (hhmm: string, date = '2026-09-15') => `${date}T${hhmm}:00-04:00[America/New_York]`;
const svg = (body: string) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 76 64" preserveAspectRatio="xMidYMid slice">${body}</svg>`)}`;

/** The frames' 3 pictures (DK-110 Success): the nameplate, the filter and the burners. */
export const PREVIEW_FILES: ReadonlyMap<string, string> = new Map([
  ['00000000-0000-4000-8000-0000000000a1', svg('<rect width="76" height="64" fill="#5d6670"/><rect x="10" y="8" width="56" height="46" rx="3" fill="#c9ced3"/><rect x="16" y="14" width="44" height="6" fill="#7b848d"/>')],
  ['00000000-0000-4000-8000-0000000000a2', svg('<rect width="76" height="64" fill="#3a3f45"/><rect x="8" y="10" width="60" height="44" fill="#e8e2d2"/>')],
  ['00000000-0000-4000-8000-0000000000a3', svg('<rect width="76" height="64" fill="#2a2d31"/><rect x="0" y="40" width="76" height="24" fill="#3b3f44"/><path d="M14 42c2-10 6-14 6-20 3 6 5 10 4 20zM30 42c2-12 6-16 6-22 3 7 5 12 4 22zM46 42c2-10 6-14 6-20 3 6 5 10 4 20z" fill="#3d8bfd"/>')],
]);

export const HAROLD: JobCopy = {
  job: {
    jobNumber: 24830, version: 3, status: 'scheduled', zone: 'America/New_York', date: '2026-09-15', today: true,
    window: { start: z('10:00'), end: z('12:00') }, serviceLabelKey: 'service.furnace_tune_up.screen', problem: null,
    onTheWayAt: null, arrivedAt: null, endedAt: null, position: { index: 2, of: 5 }, nextJob: 24835,
  },
  customer: { name: 'Harold Jenkins', address: '418 Maple Hollow Ct, Westerville', area: 'Westerville', phone: '(614) 555-0148', gettingIn: 'Use the side door. Knock firmly.', notes: [] },
  equipment: [
    { id: 'e1', type: 'furnace', year: 2014, location: 'basement', details: 'Gas furnace, 80,000 BTU, 96% efficient. Filter 16x25x4' },
    { id: 'e2', type: 'air_conditioner', year: 2014, location: 'outdoor unit on the east side', details: 'central air, 2.5 ton' },
  ],
  history: [
    { date: '2025-10-14', what: null, serviceLabelKey: 'service.furnace_tune_up.screen', technician: 'Maria Santos' },
    { date: '2025-06-09', what: null, serviceLabelKey: 'service.ac_tune_up.screen', technician: 'Brian Schaefer' },
    { date: '2024-01-22', what: 'No heat, new igniter', serviceLabelKey: null, technician: 'Tom R.' },
  ],
  notes: [
    { id: 'n1', kind: 'technician', author: 'Maria Santos', body: 'Bring a 16x25x4 filter. Flame sensor was dirty last year; check it again.', at: z('10:50', '2025-10-14') },
    { id: 'n2', kind: 'office', author: 'Keisha T.', body: 'The doorbell does not work.', at: z('15:10', '2026-09-10') },
  ],
  photos: [...PREVIEW_FILES.keys()].map((key) => ({ key, by: 'Maria Santos', at: z('10:55', '2025-10-14') })),
};
const withStatus = (status: JobCopy['job']['status'], extra: Partial<JobCopy['job']> = {}): JobCopy => ({ ...HAROLD, job: { ...HAROLD.job, status, ...extra } });
export const ON_SITE = withStatus('on_site', { onTheWayAt: z('10:20'), arrivedAt: z('10:41') });
export const DONE = withStatus('done', { arrivedAt: z('10:41'), endedAt: z('12:50') });
export const NO_ONE_HOME = withStatus('no_one_home', { endedAt: z('10:52') });
export const CANCELED = { ...withStatus('canceled'), notes: [HAROLD.notes[1]!] };

const stamp = (n: number, hhmm: string) => ({
  key: `00000000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`, worldEpoch: 1, deviceTime: z(hhmm), offsetSavedReal: z('07:00'), sinceSaveMs: 0,
  demoTime: z(hhmm), enteredRealMs: 0, jobNumber: 24830, baseVersion: 3, userId: 'u-maria',
});
export const W_NOTE1: QueuedItem = { ...stamp(1, '10:58'), kind: 'note', payload: { text: 'Flame sensor cleaned' } };
export const W_PHOTO: QueuedItem = { ...stamp(2, '11:01'), kind: 'photo', contentType: 'image/jpeg', baseVersion: null };
export const W_NOTE2: QueuedItem = { ...stamp(3, '11:04'), kind: 'note', payload: { text: 'Hose cracked at trap' } };
export const W_NOTE3: QueuedItem = { ...stamp(4, '11:07'), kind: 'note', payload: { text: 'Replaced 6 ft of condensate hose. Heat exchanger looks clean, no cracks.' } };

export const W_FINISH: QueuedItem = { ...stamp(5, '12:49'), kind: 'finished', payload: { parts: [], noPartsUsed: false, laborMinutes: 45, workDone: [] } };

const base: OutboxState = { ready: true, waiting: [], online: true, sending: false, oldCount: 0, lastSent: [], signedOut: false };
export const OUT = {
  synced: base,
  offline3: { ...base, online: false, waiting: [W_NOTE1, W_PHOTO, W_NOTE2] },
  offline1: { ...base, online: false, waiting: [W_NOTE1] },
  offline4: { ...base, online: false, waiting: [W_NOTE1, W_PHOTO, W_NOTE2, W_NOTE3] },
  waiting3: { ...base, waiting: [W_NOTE1, W_PHOTO, W_NOTE2] },
  sending3: { ...base, sending: true, waiting: [W_NOTE1, W_PHOTO, W_NOTE2] },
  partial: {
    ...base,
    waiting: [{ ...W_PHOTO, lastTry: { atRealMs: 0, outcome: 'network' as const } }],
    lastSent: [W_NOTE1, W_NOTE2].map((i): AnsweredItem => ({ key: i.key, kind: i.kind, jobNumber: i.jobNumber, enteredRealMs: 0, answeredRealMs: 0, result: 'applied', code: null, messageKey: null, values: null })),
  },
  // DK-111 Refused: the server answered the Finished item parts_required (UI-SPECIFICATION 4.5 rule 10); it stays in the list with its message.
  refused: { ...base, waiting: [{ ...W_FINISH, lastTry: { atRealMs: 0, outcome: 'refused' as const, code: 'parts_required' } }] },
  // DK-111 Old items: the photo was entered the day before (Mon, Sep 14, 11:01 AM), over 24 hours of the phone's time ago.
  old: { ...base, oldCount: 1, waiting: [{ ...W_PHOTO, enteredRealMs: -25 * 3_600_000, demoTime: z('11:01', '2026-09-14') }, W_NOTE2] },
} satisfies Record<string, OutboxState>;

export const PARTS: Part[] = [
  { partId: 'p1', name: 'Furnace filter 16x25x4 MERV 11', code: 'FLT-16254', priceCents: 3200 },
  { partId: 'p2', name: 'Condensate hose, 3/4 in, per ft', code: 'HOS-0750', priceCents: 300 },
  { partId: 'p3', name: 'Hose clamp, 3/4 in', code: 'CLP-0750', priceCents: 150 },
  { partId: 'p4', name: 'Run capacitor 45/5 MFD', code: 'CAP-455', priceCents: 2400 },
  { partId: 'p5', name: 'Run capacitor 35/5 MFD', code: 'CAP-355', priceCents: 2200 },
];
const rows = (n: number) => [['p1', 1], ['p2', 6], ['p3', 2]].slice(0, n).map(([id, q]) => {
  const p = PARTS.find((x) => x.partId === id)!;
  return { partId: p.partId, name: p.name, code: p.code, quantity: q as number };
});
const LINES = ['Tune-up done, all readings normal', 'Cleaned the flame sensor, new filter', 'Replaced cracked condensate hose'];
/** A 1 x 1 transparent PNG: the preview's stand-in for the signature the frame draws. */
const PNG_1 = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
export const FINISH = {
  signed: { jobNumber: 24830, parts: rows(3), noPartsUsed: false, hours: '2', minutes: '9', workDone: LINES, signature: { png: PNG_1, at: z('12:49') } },
  editing: { jobNumber: 24830, parts: [], noPartsUsed: false, hours: '2', minutes: '9', workDone: ['Tune-up done, all readings normal', ''], signature: null },
  empty: { jobNumber: 24830, parts: [], noPartsUsed: false, hours: '2', minutes: '9', workDone: LINES, signature: null },
  confirming: { jobNumber: 24830, parts: rows(3), noPartsUsed: false, hours: '2', minutes: '9', workDone: LINES, signature: { png: PNG_1, at: z('12:49') } },
  restored: { jobNumber: 24830, parts: rows(2), noPartsUsed: false, hours: '2', minutes: '9', workDone: LINES.slice(0, 2), signature: null },
} satisfies Record<string, FinishDraft>;
export const ON_SITE_NOTES: JobCopy = {
  ...ON_SITE,
  notes: [
    { id: 't3', kind: 'technician', author: 'Maria Santos', body: 'Replaced 6 ft of hose; no leak.', at: z('11:09') },
    { id: 't2', kind: 'technician', author: 'Maria Santos', body: 'Condensate hose cracked by the trap.', at: z('11:04') },
    { id: 't1', kind: 'technician', author: 'Maria Santos', body: 'Flame sensor dirty again; cleaned it.', at: z('10:58') },
  ],
  photos: [...HAROLD.photos, { key: '00000000-0000-4000-8000-0000000000a4', by: 'Maria Santos', at: z('11:02') }],
};
