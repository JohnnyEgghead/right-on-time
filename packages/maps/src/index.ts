// SPDX-License-Identifier: AGPL-3.0-or-later
// @bw/maps (SPECIFICATIONS section 6.10, D7, SD-49): the map manifest check, the legs the track bake routes, the track loader, the step mapping
// and the route source (legFor: the stored track, else a live route, else approximate).
export { MANIFEST_FILE, MAPS_DIR, MapError, SIZE_GATE_BYTES, loadMapManifest, mapAsset, sha256File, verifyMapFile, verifyMaps } from './manifest.ts';
export type { MapAsset, MapErrorCode, MapManifest } from './manifest.ts';
export { HEADER_BYTES, parsePmtilesHeader, readPmtilesHeader } from './pmtiles.ts';
export type { PmtilesHeader } from './pmtiles.ts';
export { DEMO_WEEK, PAIR_DAY, PRESET_DAYS, buildLegs, legKey } from './legs.ts';
export type { Leg, LegSet, RosterTechnician } from './legs.ts';
export { decodePolyline, encodePolyline, loadVanTracks, parseTracks, trackKey } from './tracks.ts';
export {
  configureRouting, LIVE_ROUTE_BUDGET_MS, LIVE_ROUTE_CONCURRENCY, legFor, legsFor, osrmRoutingService, osrmRouteUrl, ROUTING_SERVICE_URL, routedDrive, trackFromOsrm,
} from './route-source.ts';
export type { LegAnswer, LegStop, OsrmRoute, RouteTrack, RoutingService } from './route-source.ts';
export type { TrackDb, TrackRow } from './tracks.ts';
export { pointAlongLine, pointAlongTrack, positionAt, stepsFromVan, trackMinutes, trackSeconds, vanOnTrack, visitPosition } from './position.ts';
export {
  FOLDED_TYPES, KNOWN_TYPES, STEP_DIRECTIONS, STEP_HEADINGS, STEP_KINDS, STEP_SIDES, StepMappingError, stepsFromOsrm, stepVertexIndexes,
  UnknownManeuverError,
} from './steps.ts';
export type { OsrmStep, StepDirection, StepHeading, StepKind, StepSide, TrackStep } from './steps.ts';
export type { DayStop, LegTrack, Point, PositionInput, VisitPositionInput } from './position.ts';
export { checkCoverage } from './coverage.ts';
export type { CoverageResult } from './coverage.ts';
