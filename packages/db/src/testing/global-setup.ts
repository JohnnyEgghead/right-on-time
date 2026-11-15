// SPDX-License-Identifier: AGPL-3.0-or-later
// Vitest globalSetup for the database test set: 1 PostgreSQL 18 server for the whole run, its admin URL provided
// to every test file as inject('pgAdminUrl'); stopped (and its data directory removed) when the run ends.
import type { TestProject } from 'vitest/node';
import { startPgServer } from './pg-server.ts';
import type {} from './provided.ts'; // the ProvidedContext keys

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const server = await startPgServer();
  project.provide('pgAdminUrl', server.adminUrl);
  project.provide('pgVersion', server.version);
  return () => server.stop();
}
