// SPDX-License-Identifier: AGPL-3.0-or-later
// What the database test set's globalSetup provides to every test file (vitest provide/inject), typed once.
import { inject } from 'vitest';

declare module 'vitest' {
  export interface ProvidedContext {
    pgAdminUrl: string;
    pgVersion: string;
  }
}

/** Superuser URL of the run's PostgreSQL 18 server (its `postgres` database). */
export const pgAdminUrl = (): string => inject('pgAdminUrl');
/** The server's server_version, for example "18.4". */
export const pgVersion = (): string => inject('pgVersion');
