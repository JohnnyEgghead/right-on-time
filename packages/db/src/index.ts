// SPDX-License-Identifier: AGPL-3.0-or-later
// @bw/db (SPECIFICATIONS SD-2): migrations and 1 repository module per entity of section 3.
export { createClient, createPool, inTransaction, pgTypes, SERVICE_LOCK_TIMEOUT_MS, SERVICE_STATEMENT_TIMEOUT_MS, SERVICE_TIMEOUTS, type Queryable, type QueryResultLike, type Row } from './client.ts';
export {
  loadMigrations, migrate, migrateUrl, MIGRATIONS_DIR, MigrationDriftError, MigrationOrderError,
  type MigrateResult, type Migration,
} from './migrate.ts';
export {
  appendOnlyRepository, mutableRepository, readOnlyRepository,
  type Access, type AppendRepository, type FindOptions, type MutableRepository, type ReadRepository, type TableDef, type Where,
} from './repository.ts';
export { legTrackSeconds, type LegWanted } from './track-seconds.ts';
export { deleteTracksNaming, LIVE_BUILD_ID, readTracks, storeLiveTrack, TRACK_LOCK_CLASS, type StopRef, type StoredTrack, type StoreOutcome } from './van-tracks.ts';
export { zoneRegistry, type ZoneDeclaration, type ZoneOwner } from './zone-registry.ts';
export * from './repositories/index.ts';
// The street-list loader (./street-list.ts) is not exported here: only setup and the generator use it, and a process
// importing @bw/db should not load it (F-216). Its users import the module itself. Its verify half, data-asset.ts, is
// inside this package (F-185), so the module reaches no ci/ file.
export { foldStreetName } from './fold.ts';
export { ensurePasswordFile, passwordFile, PROCESS_LOGINS, provisionLogins, setLoginPassword, type ProcessLogin } from './logins.ts';
// Password hashing and the sample passwords (SD-8, SD-9): used by the seed, sign-in and API-15.
export { hashPassword, samplePassword, showSamplePassword, verifyPassword } from './passwords.ts';
// The event bus contract and publish helper (SPECIFICATIONS 4.3, SD-13): the one place the channel and payload are named.
export {
  alertEventIds, BUS_CHANNEL, decodeNotification, encodeNotification, EVENT_NAMES, publishEvent, type BusEvent, type EventIds, type EventName,
} from './events.ts';
// The on-screen email store (SD-29, FR-AUTH-8): messages and one-time links, shared by alerts, invites and resets.
export { EMAIL_KINDS, EMAIL_LINK_HOURS, hashToken, newToken, openEmailLink, sendEmail, type EmailKind, type NewEmail, type OpenedEmail, type SentEmail } from './email-store.ts';
// The world reset of SD-12 (API-14, the idle watcher, the nightly job): restore_world() and the clock row, 1 transaction.
export { CLOCK_MOVE_LOCK_CLASS, IDLE_MOVER, lockClockMoves, NIGHTLY_MOVER, readClockAt, RESET_DEMO_TIME, ResetRefused, resetWorld, type LockedClock, type ResetResult } from './world-reset.ts';
