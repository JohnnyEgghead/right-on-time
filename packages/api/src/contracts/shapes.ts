// SPDX-License-Identifier: AGPL-3.0-or-later
// The shared date, time and text shapes of the contract rows. Each refuses, as validation_failed, a value its handler or its
// column cannot hold (F-753, F-740, F-766; the class of F-260): a date the calendar does not have, an hour past 23, a NUL in text.
import { z } from 'zod';

/** True when "YYYY-MM-DD" names a day the calendar has (2026-02-30 and 2026-13-45 do not). */
export const isRealDate = (date: string): boolean => {
  const d = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
};

/** A branch-local day, "YYYY-MM-DD", that the calendar has. */
export const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isRealDate, 'not a date the calendar has');
/** A branch-local clock value, "HH:MM", from 00:00 to 23:59. */
export const localTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
/** Text PostgreSQL can store: no NUL. Add .trim(), .min and .max where the field needs them. */
export const NO_NUL = /^[^\u0000]*$/;
/** The week is named by its Monday. */
export const isMonday = (date: string): boolean => new Date(`${date}T00:00:00Z`).getUTCDay() === 1;
