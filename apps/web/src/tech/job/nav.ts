// SPDX-License-Identifier: AGPL-3.0-or-later
// The job screens' shared words and moves, in a module of their own: each screen imports only its own frame's sheet, so a
// screen never imports another screen's module (that would load the other frame's page sheet too).
import type { MessageKey } from '@bw/i18n/src/catalog.ts';
import type { JobStatus } from './model.ts';

export const jobHref = (n: number, sub = ''): string => `/tech/jobs/${n}${sub}`;
/** A move between the app's screens is a document load: the service worker serves each page with no signal, and each page loads only its own frame's sheet. */
export const go = (href: string): void => window.location.assign(href);
/**
 * CTL-TEC-04-13, -14, -17: On my way, Arrived and No one home are Today's confirm sheets (SCR-TEC-03, -13, -14; P5-TWA-TODAY): the job's
 * button opens Today with the sheet asked for this job (today/TodayScreen.tsx reads it). The service worker keys a page by its path, so
 * it opens with no signal too.
 */
export const todaySheetHref = (sheet: 'omw' | 'arrived' | 'noh', n: number): string => `/tech?sheet=${sheet}&job=${n}`;

export const STATUS_WORD: Record<JobStatus, MessageKey> = {
  scheduled: 'tech.status.scheduled', on_the_way: 'tech.status.onTheWay', on_site: 'tech.status.onSite', done: 'tech.status.done',
  no_one_home: 'tech.status.noOneHome', canceled: 'tech.status.canceled',
};
