// SPDX-License-Identifier: AGPL-3.0-or-later
// @bw/time (SPECIFICATIONS section 4.2, SD-10): the only reader of the system clock, the demo clock, Temporal-based
// local-time computation and the shared time formatter (SD-47).
export { Temporal } from 'temporal-polyfill';
export {
  CLOCK_CACHE_MS, CLOCK_ROW_SQL, DbClock, demoTimeAt, FixedClock,
  type Clock, type ClockDb, type ClockRow, type DbClockOptions, type FixedClockInit, type Instant,
} from './clock.ts';
export { dateParts, formatTime, formatTimeWithZone, zoneAbbreviation, type DateParts, type Language } from './format.ts';
export { realNow } from './real.ts';
export { assertRealTimeUse, isRealTimeUse, REAL_TIME_USES, type RealTimeUse } from './uses.ts';
export {
  addDays, atLocal, fromWire, inLocalWindow, localDateOf, localTimeOf, nextLocalTime, toWire, zoned,
  type Disambiguation, type LocalDate, type LocalTime, type Zone,
} from './zone.ts';
