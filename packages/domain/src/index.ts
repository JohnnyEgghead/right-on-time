// SPDX-License-Identifier: AGPL-3.0-or-later
// @bw/domain (SPECIFICATIONS SD-2): the status machine and rules, pure. No database, no clock, no I/O.
export {
  DAY_CAPACITY, dayKind, dayRoom, INSTALLER_DAY_CAPACITY, isLive, isoWeek, offeredWindows, PER_WINDOW_LIMIT, SATURDAY_WINDOW_STARTS,
  technicianDayCapacity, technicianHasRoom, technicianRoomLimit, windowRoom, worksOn,
  type DayKind, type DayMode, type JobStatus, type RoomLimit, type Saturdays, type TechnicianFacts, type WindowFacts,
} from './capacity.ts';
export {
  approximateDriveMinutes, AT_RISK_MARGIN_MINUTES, etaDay, ETA_SWEEP_EVERY_MINUTES, firstOverlap, isLateEnoughToText, LATE_TEXT_MINUTES, legRef, legsAsked, overlaps, PASSED_ETA_MINUTES,
  planDay, previousStop, timingOf, trackedDriveMinutes,
  type DriveMinutes, type EtaResult, type LegAsk, type EtaStatus, type EtaStop, type PlannedStop, type PlanStop, type Point,
} from './planner.ts';
export * from './billing.ts';
export * from './finishLines.ts';
export * from './invoice.ts';
export * from './techItems.ts';
export * from './alerts.ts';
export * from './dispatch.ts';
export { areaName, areaSql, NEIGHBORHOOD_BY_ZIP } from './places.ts';
