// SPDX-License-Identifier: AGPL-3.0-or-later
// Pure helpers of SCR-OFC-04 New job (UI-SPECIFICATION SCR-OFC-04; FR-DISP-8, FR-DISP-28): what the page has picked, when Schedule is
// allowed, the room bars, the suggested-technician lines (CTL-OFC-04-08, CTL-OFC-04-17) and the confirmation notice (CTL-OFC-04-19). No
// React, no network.
import type { AvailabilityAnswer, SuggestedTechniciansAnswer } from '@bw/api';
import type { MessageKey } from '@bw/i18n';
import { spanText } from '../board/model.ts';
import { refusalShown, type Refusal, type Shown } from '../job/model.ts';
import type { IconName } from '../shell/icon-paths.ts';
import type { ClientT } from '../shell/intl.tsx';
import type { Detail, SearchHit } from '../customers/types.ts';

export type Day = AvailabilityAnswer['days'][number];
export type Tech = SuggestedTechniciansAnswer['technicians'][number];

/** The picks of steps 2 to 4 (the customer is the page's own state). `technicianId` null is "No technician yet". */
export interface Picks {
  serviceId: string | null;
  equipmentId: string | null;
  problem: string;
  day: string | null;
  windowId: string | null;
  technicianId: string | null;
}
export const NO_PICKS: Picks = { serviceId: null, equipmentId: null, problem: '', day: null, windowId: null, technicianId: null };

/** CTL-OFC-04-10: "Leave without saving this job?" is asked when the page holds input: a typed search, a picked customer or any pick. */
export const hasInput = (query: string, customer: unknown, p: Picks): boolean =>
  query.trim() !== '' || customer !== null || p.serviceId !== null || p.equipmentId !== null || p.problem.trim() !== '' || p.day !== null;

/** CTL-OFC-04-09: enabled when the customer, service, day and window are picked. */
export const canSchedule = (customer: unknown, p: Picks): boolean => customer !== null && p.serviceId !== null && p.day !== null && p.windowId !== null;

/** The days the office may pick from: a Closed day (Sunday) is not drawn, as DK-89 draws its days; a Full day is drawn and cannot be picked. */
export const offeredDays = (days: readonly Day[]): Day[] => days.filter((d) => d.state !== 'closed');

/** A day whose windows are all Full, or that has none: the No windows state (SCR-OFC-04). */
export const noOpenWindow = (day: Day): boolean => day.windows.every((w) => w.state === 'full');

/** The room bar's fill (DK-89 draws 80, 60, 40 for 1, 2, 3 left and 100 for Full): the share of 5 that is taken, in steps of 20. */
export const roomFill = (left: number, full: boolean): 0 | 20 | 40 | 60 | 80 | 100 =>
  full ? 100 : ((Math.max(0, 5 - Math.min(Math.max(left, 0), 5)) * 20) as 0 | 20 | 40 | 60 | 80);

/** The service icons of DK-89's picker; a service it does not draw takes its nearest trade's. */
const SERVICE_ICON: Record<string, IconName> = {
  furnace_tune_up: 'flame', ac_tune_up: 'snow', heating_or_ac_fix: 'wrench', plumbing_repair: 'drop', water_heater: 'heater', thermostat: 'gauge',
  boiler_repair: 'flame', sump_pump_install: 'drop', tankless_heater_flush: 'heater',
};
export const serviceIcon = (serviceId: string): IconName => SERVICE_ICON[serviceId] ?? 'wrench';

/** "10 AM", "10:20 AM" from an RFC 9557 time (DK-89's reason line). */
export function hourText(wire: string): string {
  const x = /T(\d{2}):(\d{2})/.exec(wire);
  if (!x) return wire;
  const h = Number(x[1]);
  const m = Number(x[2]);
  return `${h % 12 === 0 ? 12 : h % 12}${m === 0 ? '' : `:${String(m).padStart(2, '0')}`} ${h < 12 ? 'AM' : 'PM'}`;
}

const SKILL_WORDS: Record<string, MessageKey> = {
  plumbing: 'newjob.skill.plumbing', heating_cooling: 'newjob.skill.heating_cooling', install: 'newjob.skill.install',
};
/** A skill key in words ("plumbing"); a key the page has no word for shows as it is. */
export const skillWord = (t: ClientT, skill: string): string => (SKILL_WORDS[skill] ? t(SKILL_WORDS[skill] as MessageKey) : skill);

/** The technicians the page lists: those with room, the suggested ones first in the server's order, then "Not suggested" (CTL-OFC-04-08). */
export function listed(technicians: readonly Tech[]): { suggested: Tech[]; notSuggested: Tech[] } {
  const withRoom = technicians.filter((x) => x.room);
  return { suggested: withRoom.filter((x) => x.suggested), notSuggested: withRoom.filter((x) => !x.suggested) };
}

/**
 * "Lightest day" or "Closest" (CTL-OFC-04-17): the word that starts the line of a suggested technician below the top row who has the
 * lowest load that day or the fewest minutes from the stop before, alone in it. The top row is ranked first for its skill, its
 * minutes and its load already, so it takes no word (DK-89: Greg's line starts "Lightest day", Kevin's, the top, does not).
 */
export function standout(suggested: readonly Tech[], id: string): 'lightest' | 'closest' | null {
  if (suggested.length < 2 || suggested[0]?.id === id) return null;
  const me = suggested.find((x) => x.id === id);
  if (!me) return null;
  const ratio = (x: Tech) => (x.load.capacity > 0 ? x.load.jobs / x.load.capacity : 1);
  const alone = (key: (x: Tech) => number) => suggested.every((x) => x.id === id || key(x) > key(me));
  if (alone(ratio)) return 'lightest';
  if (alone((x) => x.minutesFromStopBefore)) return 'closest';
  return null;
}

/** CTL-OFC-04-17: why a technician is ranked where they are. Not suggested rows keep their reason (CTL-OFC-04-08). */
export function reasonLine(t: ClientT, tech: Tech, serviceSkill: string, word: 'lightest' | 'closest' | null): string {
  if (!tech.suggested) return t('newjob.tech.noSkill', { skill: skillWord(t, serviceSkill) });
  const parts: string[] = [];
  if (word) parts.push(t(word === 'lightest' ? 'newjob.why.lightest' : 'newjob.why.closest'));
  const services = t('newjob.why.services', { skill: skillWord(t, serviceSkill) });
  parts.push(word ? services.charAt(0).toLowerCase() + services.slice(1) : services);
  parts.push(tech.stopBefore
    ? t('newjob.why.fromStop', { n: tech.minutesFromStopBefore, time: hourText(tech.stopBefore.plannedArrival), area: tech.stopBefore.area })
    : t('newjob.why.fromBranch', { n: tech.minutesFromStopBefore }));
  parts.push(t('newjob.why.load', { jobs: tech.load.jobs, capacity: tech.load.capacity }));
  return `${parts.join('; ')}.`;
}

/** The customer's text words for the notice and the toast (CTL-OFC-04-19, CMP-11): null when the customer gets texts. */
export function noTexts(c: Pick<Detail['contact'], 'mobile' | 'textsOn'>): boolean {
  return !c.textsOn || !c.mobile;
}

/** What API-28 answered about the confirmation text, in words for CMP-11 (GAP-10): sent, held for quiet hours, or no text. */
export function confirmationKey(answer: { status: string } | null): MessageKey {
  if (answer === null) return 'newjob.done.noTexts';
  return answer.status === 'held' ? 'newjob.done.held' : 'newjob.done.sent';
}

/** The toast handed to the job page that opens after Schedule (the page that opens shows CMP-11 for it). */
const HANDOFF_KEY = 'bw.newjob.toast';
export interface Handoff { jobNumber: number; key: MessageKey; values: Record<string, string | number> }
export function writeHandoff(h: Handoff): void {
  try {
    window.sessionStorage.setItem(HANDOFF_KEY, JSON.stringify(h));
  } catch {
    // Storage may be blocked: the job page opens without its toast.
  }
}
/** Read and clear the handoff for this job; null when there is none or it is another job's. */
export function takeHandoff(jobNumber: number): Handoff | null {
  try {
    const raw = window.sessionStorage.getItem(HANDOFF_KEY);
    if (raw === null) return null;
    window.sessionStorage.removeItem(HANDOFF_KEY);
    const h = JSON.parse(raw) as Handoff;
    return h.jobNumber === jobNumber && typeof h.key === 'string' ? h : null;
  } catch {
    return null;
  }
}

/** The booked visit a customer already has (CTL-OFC-04-13), from API-34's nextVisit or API-35's first upcoming visit. */
export interface Visit {
  day: string;
  window: { start: string; end: string };
  serviceId: string;
  status: 'scheduled' | 'on_the_way' | 'on_site';
  technician: string | null;
}
export const visitOfHit = (h: SearchHit): Visit | null =>
  h.nextVisit ? { day: h.nextVisit.day, window: h.nextVisit.window, serviceId: h.nextVisit.serviceId, status: h.nextVisit.status, technician: h.nextVisit.technician } : null;
export const visitOfDetail = (d: Detail): Visit | null => {
  const v = d.upcoming[0];
  return v ? { day: v.day, window: v.window, serviceId: v.serviceId, status: v.status, technician: v.technician?.name ?? null } : null;
};

/**
 * The refusal words of Schedule: API-28's technician_no_room names the limit that refused it, in the New job page's own 3 texts (SCR-OFC-04; F-1800); an answer
 * with no limit is a server fault and keeps no text of its own (F-1813). The job writes' shared codes (time_overlap names the block) follow.
 */
export function scheduleShown(r: Refusal, name: string, window: string): Shown {
  if (r.code === 'technician_no_room') {
    const { limit, max } = r.detail as { limit?: string; max?: number };
    if (limit === 'installer_day') return { key: 'newjob.refused.installerDay', values: { name } };
    if (limit === 'day') return { key: 'newjob.refused.dayFull', values: { name, max: max ?? 0 } };
    if (limit === 'window') return { key: 'newjob.refused.windowFull', values: { name, window, max: max ?? 0 } };
  }
  return refusalShown(r, spanText);
}
